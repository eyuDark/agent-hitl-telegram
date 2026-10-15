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
} as const;

export const HASH_FIELD = {
  id: "id",
  shortId: "shortId",
  status: "status",
  agentId: "agentId",
  threadId: "threadId",
  toolName: "toolName",
  risk: "risk",
  argsHash: "argsHash",
  redactedArgs: "redactedArgs",
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
