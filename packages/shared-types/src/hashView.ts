import type { ApprovalStatus } from "./schemas.js";
import type { ApprovalView } from "./schemas.js";

export type RequestHashData = {
  id: string;
  shortId: string;
  status: ApprovalStatus;
  agentId: string;
  threadId: string;
  toolName: string;
  risk: string;
  argsHash: string;
  redactedArgs: string;
  reason: string;
  callbackUrl: string;
  chatId: string;
  messageId: string;
  originalText: string;
  createdAt: string;
  expiresAt: string;
  actorId: string;
  actorUsername: string;
  resolvedAt: string;
  resolutionReason: string;
};

export function hashToView(data: RequestHashData): ApprovalView {
  return {
    id: data.id,
    shortId: data.shortId,
    status: data.status as ApprovalStatus,
    risk: data.risk as ApprovalView["risk"],
    agentId: data.agentId,
    threadId: data.threadId,
    toolName: data.toolName,
    toolArgsRedacted: parseJson(data.redactedArgs),
    toolArgsHash: data.argsHash,
    reason: emptyToNull(data.reason),
    callbackUrl: emptyToNull(data.callbackUrl),
    telegramChatId: data.chatId,
    telegramMessageId: emptyToNull(data.messageId),
    resolvedByTelegramId: emptyToNull(data.actorId),
    resolvedByUsername: emptyToNull(data.actorUsername),
    resolutionReason: emptyToNull(data.resolutionReason),
    expiresAt: data.expiresAt,
    createdAt: data.createdAt,
    resolvedAt: emptyToNull(data.resolvedAt),
  };
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function parseJson(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
