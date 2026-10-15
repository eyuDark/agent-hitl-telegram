import type { ApprovalStatus } from "./schemas.js";
import { RESOLVE_APPROVAL_LUA } from "./lua.js";
import { redisKeys } from "./keys.js";

type Evalable = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export type ResolveOutcome =
  | { ok: true; status: ApprovalStatus }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "ALREADY_RESOLVED"; status: ApprovalStatus }
  | { ok: false; error: "UNKNOWN"; raw: unknown };

export async function resolveApproval(
  redis: Evalable,
  shortId: string,
  nextStatus: ApprovalStatus,
  actorId: string,
  reason: string | null,
  resolvedAt: string = new Date().toISOString(),
): Promise<ResolveOutcome> {
  const raw = await redis.eval(
    RESOLVE_APPROVAL_LUA,
    1,
    redisKeys.request(shortId),
    nextStatus,
    actorId,
    resolvedAt,
    reason ?? "",
  );

  if (!Array.isArray(raw) || raw.length < 2) {
    return { ok: false, error: "UNKNOWN", raw };
  }

  const [flag, detail] = raw as [string, string];

  if (flag === "OK") {
    return { ok: true, status: detail as ApprovalStatus };
  }
  if (flag === "NOT_FOUND") {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (flag === "ALREADY_RESOLVED") {
    return { ok: false, error: "ALREADY_RESOLVED", status: detail as ApprovalStatus };
  }
  return { ok: false, error: "UNKNOWN", raw };
}
