import type { ApprovalView, RiskLevel, ApprovalStatus } from "./schemas.js";

export type CallbackAction = "approve" | "deny";

const ACTION_CODES: Record<CallbackAction, string> = {
  approve: "ap",
  deny: "dn",
};

const CODE_ACTIONS: Record<string, CallbackAction> = {
  ap: "approve",
  dn: "deny",
};

export function encodeCallback(action: CallbackAction, shortId: string): string {
  return `act:${ACTION_CODES[action]}:${shortId}`;
}

export function decodeCallback(
  data: string | undefined,
): { action: CallbackAction; shortId: string } | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, code, shortId] = parts as [string, string, string];
  if (prefix !== "act") return null;
  const action = CODE_ACTIONS[code];
  if (!action) return null;
  if (!shortId) return null;
  return { action, shortId };
}

export function buildApprovalMessage(view: ApprovalView): string {
  const redacted = safeStringify(view.toolArgsRedacted);
  const argsBlock = redacted.length > 1200 ? `${redacted.slice(0, 1200)}…` : redacted;
  const expires = new Date(view.expiresAt).toISOString().replace(".000Z", "Z");

  return [
    `🔐 HITL Approval Request [${view.shortId}]`,
    ``,
    `Tool: ${view.toolName}`,
    `Risk: ${view.risk}`,
    `Agent: ${view.agentId}`,
    `Thread: ${view.threadId}`,
    view.reason ? `Reason: ${view.reason}` : null,
    ``,
    `Arguments (redacted):`,
    argsBlock,
    ``,
    `Expires: ${expires}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildResolvedMessage(view: ApprovalView, stamp: string): string {
  const base = buildApprovalMessage(view).replace(/🔐 HITL Approval Request/, "📋 HITL Approval Request");
  return `${base}\n\n${stamp}`;
}

export function resolutionStamp(
  status: ApprovalStatus,
  actorLabel: string,
  at: string,
): string {
  const time = new Date(at).toISOString().replace(".000Z", "Z");
  switch (status) {
    case "APPROVED":
      return `✅ APPROVED by ${actorLabel} at ${time}`;
    case "DENIED":
      return `❌ DENIED by ${actorLabel} at ${time}`;
    case "EXPIRED":
      return `⏳ EXPIRED — auto-rejected due to timeout at ${time}`;
    case "CANCELLED":
      return `🚫 CANCELLED by ${actorLabel} at ${time}`;
    default:
      return `Status: ${status} at ${time}`;
  }
}

export function riskLabel(risk: RiskLevel): string {
  return `#${risk}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}
