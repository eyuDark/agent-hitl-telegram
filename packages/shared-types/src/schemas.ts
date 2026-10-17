import { z } from "zod";

export const approvalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "DENIED",
  "ANSWERED",
  "EXPIRED",
  "CANCELLED",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const requestKindSchema = z.enum(["DECISION", "CHOICE", "QUESTION"]);
export type RequestKind = z.infer<typeof requestKindSchema>;

export const choiceOptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/, "option id must be alphanumeric/dash/underscore"),
  label: z.string().min(1).max(64),
  followUpPrompt: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("If selected, the operator is asked this follow-up question before resolving"),
});
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

export const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval"), decision: z.enum(["APPROVED", "DENIED"]) }),
  z.object({
    type: z.literal("choice"),
    optionId: z.string(),
    label: z.string(),
    index: z.number().int().min(0),
    followUpPrompt: z.string().optional(),
    followUpText: z.string().optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);
export type Answer = z.infer<typeof answerSchema>;

export function isTerminal(status: ApprovalStatus): boolean {
  return status !== "PENDING";
}

export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const createApprovalRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    agentId: z.string().min(1).max(64),
    threadId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    toolArgs: z.unknown().optional(),
    reason: z.string().max(2000).optional(),
    risk: riskLevelSchema.default("HIGH"),
    kind: requestKindSchema.default("DECISION"),
    prompt: z.string().min(1).max(2000).optional(),
    options: z.array(choiceOptionSchema).min(2).max(10).optional(),
    callbackUrl: z.string().url().optional(),
    ttlSeconds: z.number().int().min(30).max(86_400).default(900),
    telegramChatId: z
      .union([z.string(), z.number()])
      .transform((value) => String(value))
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "CHOICE") {
      if (!value.options || value.options.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "CHOICE requests require 2-10 options",
        });
      }
      if (!value.prompt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prompt"],
          message: "CHOICE requests require a prompt",
        });
      }
      const ids = new Set((value.options ?? []).map((option) => option.id));
      if (ids.size !== (value.options ?? []).length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "option ids must be unique",
        });
      }
      const labels = new Set((value.options ?? []).map((option) => option.label));
      if (labels.size !== (value.options ?? []).length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: "option labels must be unique (labels are how selections are matched)",
        });
      }
    }
    if (value.kind === "QUESTION" && !value.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "QUESTION requests require a prompt",
      });
    }
    if (value.kind === "DECISION" && value.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "DECISION requests do not take options",
      });
    }
  });
export type CreateApprovalRequest = z.input<typeof createApprovalRequestSchema>;

export const cancelApprovalSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const approvalViewSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  status: approvalStatusSchema,
  kind: requestKindSchema,
  risk: riskLevelSchema,
  agentId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  toolArgsRedacted: z.unknown(),
  toolArgsHash: z.string(),
  prompt: z.string().nullable(),
  options: z.array(choiceOptionSchema).nullable(),
  answer: answerSchema.nullable(),
  reason: z.string().nullable(),
  callbackUrl: z.string().nullable(),
  telegramChatId: z.string(),
  telegramMessageId: z.string().nullable(),
  telegramThreadId: z.string().nullable(),
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
  answer: answerSchema.optional(),
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
  kind: requestKindSchema,
  agentId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  toolArgsHash: z.string(),
  answer: answerSchema.nullable(),
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

export type TtlRemoteAuditJobData = {
  enabledAt: string;
  chatId: string;
  topicId: string | null;
  agentId: string | null;
  threadId: string | null;
};

export type TtlJobData =
  | {
      shortId: string;
      postponed?: number;
    }
  | TtlRemoteAuditJobData;

export type OutboundJobData = {
  chatId: string;
  topicId: string | null;
  agentId: string;
  threadId: string;
  message: string;
  createdAt: string;
};

export type ResolutionJobData = {
  shortId: string;
  newStatus: Extract<
    ApprovalStatus,
    "APPROVED" | "DENIED" | "ANSWERED" | "CANCELLED" | "EXPIRED"
  >;
  actorId: string;
  actorUsername: string | null;
  resolvedAt: string;
  reason: string | null;
  answerJson: string | null;
};

export type ResumeJobData = {
  shortId: string;
};
