import type { approval_requests } from "@prisma/client";
import { approvalViewSchema, type ApprovalView } from "@hitl/shared-types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifySharedSecret } from "@hitl/shared-types";
import { config } from "../config.js";

export function toView(row: approval_requests): ApprovalView {
  return approvalViewSchema.parse({
    id: row.id,
    shortId: row.short_id,
    status: row.status,
    kind: row.kind,
    risk: row.risk,
    agentId: row.agent_id,
    threadId: row.thread_id,
    toolName: row.tool_name,
    toolArgsRedacted: row.tool_args_redacted,
    toolArgsHash: row.tool_args_hash,
    prompt: row.prompt,
    options: row.options_json,
    answer: row.answer_json,
    reason: row.reason,
    callbackUrl: row.callback_url,
    telegramChatId: String(row.telegram_chat_id),
    telegramMessageId:
      row.telegram_message_id === null ? null : String(row.telegram_message_id),
    resolvedByTelegramId:
      row.resolved_by_telegram_id === null ? null : String(row.resolved_by_telegram_id),
    resolvedByUsername: row.resolved_by_username,
    resolutionReason: row.resolution_reason,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
  });
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.apiKey) return;
  const provided = request.headers["x-api-key"];
  const header = Array.isArray(provided) ? provided[0] : provided;
  if (!verifySharedSecret(header, config.apiKey)) {
    await reply.code(401).send({ error: "Unauthorized: missing or invalid API key" });
  }
}
