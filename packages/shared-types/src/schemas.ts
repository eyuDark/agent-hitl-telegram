import { z } from "zod";

export const approvalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const terminalStatuses: readonly ApprovalStatus[] = [
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
];

export function isTerminal(status: ApprovalStatus): boolean {
  return status !== "PENDING";
}

export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const createApprovalRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  agentId: z.string().min(1).max(64),
  threadId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  toolArgs: z.unknown().optional(),
  reason: z.string().max(2000).optional(),
  risk: riskLevelSchema.default("HIGH"),
  callbackUrl: z.string().url().optional(),
  ttlSeconds: z.number().int().min(30).max(86_400).default(900),
  telegramChatId: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .optional(),
});
export type CreateApprovalRequest = z.input<typeof createApprovalRequestSchema>;

export const cancelApprovalSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const approvalViewSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  status: approvalStatusSchema,
  risk: riskLevelSchema,
  agentId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  toolArgsRedacted: z.unknown(),
  toolArgsHash: z.string(),
  reason: z.string().nullable(),
  callbackUrl: z.string().nullable(),
  telegramChatId: z.string(),
  telegramMessageId: z.string().nullable(),
  resolvedByTelegramId: z.string().nullable(),
  resolvedByUsername: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;

export const approvalEventSchema = z.object({
  shortId: z.string(),
  status: approvalStatusSchema,
  occurredAt: z.string(),
  actorId: z.string().optional(),
  actorUsername: z.string().optional(),
});
export type ApprovalEvent = z.infer<typeof approvalEventSchema>;

export const listApprovalsQuerySchema = z.object({
  threadId: z.string().optional(),
  agentId: z.string().optional(),
  status: approvalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const agentResumePayloadSchema = z.object({
  shortId: z.string(),
  status: approvalStatusSchema,
  agentId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  toolArgsHash: z.string(),
  reason: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedByUsername: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedAt: z.string(),
});
export type AgentResumePayload = z.infer<typeof agentResumePayloadSchema>;

export const taskCompleteSchema = z.object({
  agentId: z.string().min(1).max(64),
  threadId: z.string().min(1).max(128),
  summary: z.string().min(1).max(4000),
});

export type DispatchJobData = {
  shortId: string;
};

export type TtlJobData = {
  shortId: string;
};

export type ResolutionJobData = {
  shortId: string;
  newStatus: Extract<ApprovalStatus, "APPROVED" | "DENIED" | "CANCELLED" | "EXPIRED">;
  actorId: string;
  actorUsername: string | null;
  resolvedAt: string;
  reason: string | null;
};

export type ResumeJobData = {
  shortId: string;
};
