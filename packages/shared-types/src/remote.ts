import { z } from "zod";

export const REMOTE_KEY = "hitl:remote";

export const remoteModeSnapshotSchema = z.object({
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  enabledBy: z.string().nullable(),
  disabledAt: z.string().nullable(),
  reason: z.string().nullable(),
  agentId: z.string().nullable(),
  threadId: z.string().nullable(),
  chatId: z.string().nullable(),
  callbackUrl: z.string().nullable(),
});
export type RemoteModeSnapshot = z.infer<typeof remoteModeSnapshotSchema>;

export const remoteModeToggleSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(500).optional(),
  agentId: z.string().min(1).max(64).optional(),
  threadId: z.string().max(128).optional(),
  chatId: z
    .union([z.string(), z.number()])
    .transform(String)
    .optional(),
  callbackUrl: z.string().url().optional(),
});
export type RemoteModeToggle = z.input<typeof remoteModeToggleSchema>;

export const operatorMessageSchema = z.object({
  agentId: z.string().min(1).max(64),
  threadId: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  ttlSeconds: z.number().int().min(30).max(86_400).optional(),
});
export type OperatorMessage = z.infer<typeof operatorMessageSchema>;

export const agentMessageSchema = z.object({
  agentId: z.string().min(1).max(64),
  threadId: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const operatorMessagesQuerySchema = z.object({
  agentId: z.string().optional(),
  threadId: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  waitSeconds: z.coerce.number().int().min(0).max(60).default(0),
});
export type OperatorMessagesQuery = z.infer<typeof operatorMessagesQuerySchema>;

export const disabledRemoteSnapshot: RemoteModeSnapshot = {
  enabled: false,
  enabledAt: null,
  enabledBy: null,
  disabledAt: null,
  reason: null,
  agentId: null,
  threadId: null,
  chatId: null,
  callbackUrl: null,
};

function toBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function clean(value: string | undefined): string | null {
  return value ? value : null;
}

export function parseRemoteHash(hash: Record<string, string>): RemoteModeSnapshot {
  return {
    enabled: toBool(hash.enabled),
    enabledAt: clean(hash.enabledAt),
    enabledBy: clean(hash.enabledBy),
    disabledAt: clean(hash.disabledAt),
    reason: clean(hash.reason),
    agentId: clean(hash.agentId),
    threadId: clean(hash.threadId),
    chatId: clean(hash.chatId),
    callbackUrl: clean(hash.callbackUrl),
  };
}

export type RemoteReadStore = {
  hgetall(key: string): Promise<Record<string, string>>;
};

export type RemoteWriteStore = RemoteReadStore & {
  hset(key: string, data: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export async function getRemoteMode(redis: RemoteReadStore): Promise<RemoteModeSnapshot> {
  const hash = await redis.hgetall(REMOTE_KEY);
  if (!hash.enabled) return { ...disabledRemoteSnapshot, ...parseRemoteHash(hash) };
  return parseRemoteHash(hash);
}

export async function isRemoteModeOn(redis: RemoteReadStore): Promise<boolean> {
  return (await getRemoteMode(redis)).enabled;
}

export async function setRemoteMode(
  redis: RemoteWriteStore,
  next: {
    enabled: boolean;
    actor: string;
    reason?: string | null;
    agentId?: string | null;
    threadId?: string | null;
    chatId?: string | null;
    callbackUrl?: string | null;
    auditTtlSeconds?: number;
  },
): Promise<RemoteModeSnapshot> {
  const nowIso = new Date().toISOString();
  const ttl = next.auditTtlSeconds ?? 86_400;

  const state: Record<string, string> = next.enabled
    ? {
        enabled: "true",
        enabledAt: nowIso,
        enabledBy: next.actor,
        disabledAt: "",
        reason: next.reason ?? "",
        agentId: next.agentId ?? "",
        threadId: next.threadId ?? "",
        chatId: next.chatId ?? "",
        callbackUrl: next.callbackUrl ?? "",
      }
    : {
        enabled: "false",
        disabledAt: nowIso,
        reason: next.reason ?? "",
      };

  await redis.hset(REMOTE_KEY, state);
  await redis.expire(REMOTE_KEY, ttl);
  return parseRemoteHash(state);
}
