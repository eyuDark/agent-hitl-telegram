import type { Answer, ApprovalStatus, ApprovalView, ChoiceOption, RequestKind } from "./schemas.js";

export type RequestHashData = {
  id: string;
  shortId: string;
  status: ApprovalStatus;
  kind: string;
  agentId: string;
  threadId: string;
  toolName: string;
  risk: string;
  argsHash: string;
  redactedArgs: string;
  prompt: string;
  options: string;
  answerJson: string;
  reason: string;
  callbackUrl: string;
  chatId: string;
  messageId: string;
  originalText: string;
  chatTopicId?: string;
  createdAt: string;
  expiresAt: string;
  actorId: string;
  actorUsername: string;
  resolvedAt: string;
  resolutionReason: string;
  phase?: string;
  selectedIndex?: string;
  followUpPrompt?: string;
};

export function hashToView(data: RequestHashData): ApprovalView {
  return {
    id: data.id,
    shortId: data.shortId,
    status: data.status as ApprovalStatus,
    kind: (data.kind || "DECISION") as RequestKind,
    risk: data.risk as ApprovalView["risk"],
    agentId: data.agentId,
    threadId: data.threadId,
    toolName: data.toolName,
    toolArgsRedacted: parseJson(data.redactedArgs),
    toolArgsHash: data.argsHash,
    prompt: emptyToNull(data.prompt),
    options: parseJson(data.options) as ChoiceOption[] | null,
    answer: parseJson(data.answerJson) as Answer | null,
    reason: emptyToNull(data.reason),
    callbackUrl: emptyToNull(data.callbackUrl),
    telegramChatId: data.chatId,
    telegramMessageId: emptyToNull(data.messageId),
    telegramThreadId: emptyToNull(data.chatTopicId),
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
