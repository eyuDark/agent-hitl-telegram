export const QUEUE_NAMES = {
  dispatch: "telegram-dispatch",
  ttl: "hitl-ttl-queue",
  resolution: "hitl-resolution-queue",
  resume: "agent-resume-queue",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const redisKeys = {
  request: (shortId: string) => `hitl:req:${shortId}`,
  events: (shortId: string) => `hitl:events:${shortId}`,
  chatIndex: (chatId: string | number) => `hitl:chatidx:${chatId}`,
} as const;

export const HASH_FIELD = {
  id: "id",
  shortId: "shortId",
  status: "status",
  kind: "kind",
  agentId: "agentId",
  threadId: "threadId",
  toolName: "toolName",
  risk: "risk",
  argsHash: "argsHash",
  redactedArgs: "redactedArgs",
  prompt: "prompt",
  options: "options",
  answer: "answerJson",
  phase: "phase",
  selectedIndex: "selectedIndex",
  followUpPrompt: "followUpPrompt",
  reason: "reason",
  callbackUrl: "callbackUrl",
  chatId: "chatId",
  messageId: "messageId",
  originalText: "originalText",
  createdAt: "createdAt",
  expiresAt: "expiresAt",
  actorId: "actorId",
  actorUsername: "actorUsername",
  resolvedAt: "resolvedAt",
  resolutionReason: "resolutionReason",
} as const;

export type RequestHash = Record<string, string | undefined>;
