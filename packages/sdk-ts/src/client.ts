import {
  approvalEventSchema,
  approvalViewSchema,
  createApprovalRequestSchema,
  isTerminal,
  signPayload,
  verifySignature,
  type ApprovalEvent,
  type ApprovalStatus,
  type ApprovalView,
  type CreateApprovalRequest,
} from "@hitl/shared-types";
import { HitlApiError, HitlTimeoutError } from "./errors.js";

export type HitlClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
};

export type WaitForResolutionOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

const TERMINAL_FALLBACK: ApprovalStatus[] = ["APPROVED", "DENIED", "EXPIRED", "CANCELLED"];

export class HitlClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: HitlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  async createApproval(input: CreateApprovalRequest): Promise<ApprovalView> {
    const payload = createApprovalRequestSchema.parse(input);
    const result = await this.request<unknown>("POST", "/v1/approvals", {
      body: payload,
    });
    return approvalViewSchema.parse(result);
  }

  async getApproval(shortId: string): Promise<ApprovalView | null> {
    const result = await this.request<unknown>("GET", `/v1/approvals/${shortId}`, {
      allow404: true,
    });
    if (result === null) return null;
    return approvalViewSchema.parse(result);
  }

  async cancelApproval(shortId: string, reason?: string): Promise<ApprovalView> {
    const result = await this.request<unknown>(
      "POST",
      `/v1/approvals/${shortId}/cancel`,
      { body: { reason } },
    );
    return approvalViewSchema.parse(result);
  }

  async listApprovals(query: {
    threadId?: string;
    agentId?: string;
    status?: ApprovalStatus;
    limit?: number;
  } = {}): Promise<ApprovalView[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const result = await this.request<unknown>("GET", `/v1/approvals${suffix}`);
    const items = Array.isArray(result) ? result : [];
    return items.map((item) => approvalViewSchema.parse(item));
  }

  async waitForResolution(
    shortId: string,
    options: WaitForResolutionOptions = {},
  ): Promise<ApprovalView> {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 3_000;
    const deadline = Date.now() + timeoutMs;

    const initial = await this.getApproval(shortId);
    if (initial && isTerminal(initial.status)) return initial;
    const expiresAt = initial ? Date.parse(initial.expiresAt) : deadline;
    const effectiveDeadline = Math.min(deadline, expiresAt + 5_000);

    const streamed = await this.streamUntilResolved(
      shortId,
      effectiveDeadline,
      options.signal,
    );
    if (streamed && isTerminal(streamed.status)) {
      return approvalViewSchema.parse(streamed);
    }

    while (Date.now() < effectiveDeadline) {
      if (options.signal?.aborted) {
        throw new HitlTimeoutError(shortId, "Wait aborted by caller");
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, effectiveDeadline - Date.now())));
      const current = await this.getApproval(shortId);
      if (current && isTerminal(current.status)) return current;
    }

    const final = await this.getApproval(shortId);
    if (final && isTerminal(final.status)) return final;
    throw new HitlTimeoutError(
      shortId,
      `Approval ${shortId} was not resolved within the allowed window`,
    );
  }

  static sign(rawBody: string, secret: string): string {
    return signPayload(rawBody, secret);
  }

  static verify(rawBody: string, header: string | undefined, secret: string): boolean {
    return verifySignature(rawBody, header, secret);
  }

  private async streamUntilResolved(
    shortId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ApprovalView | null> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/approvals/${shortId}/events`, {
        headers: {
          accept: "text/event-stream",
          ...this.headers(),
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(remaining),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      return null;
    }

    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const dataLine = chunk
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const raw = dataLine.slice(5).trim();
          const parsed = approvalEventSchema.safeParse(JSON.parse(raw));
          if (parsed.success && isTerminal(parsed.data.status)) {
            await reader.cancel().catch(() => undefined);
            return await this.getApproval(shortId);
          }
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private headers(): Record<string, string> {
    const base: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) base["x-api-key"] = this.apiKey;
    return base;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; allow404?: boolean } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.defaultTimeoutMs),
      });
    } catch (error) {
      throw new HitlApiError(
        `Request to ${path} failed: ${(error as Error).message}`,
        0,
        undefined,
      );
    }

    if (response.status === 404 && options.allow404) return null as T;

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      throw new HitlApiError(
        `Request to ${path} responded ${response.status}`,
        response.status,
        body,
      );
    }

    return body as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { TERMINAL_FALLBACK };
