import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { Bot } from "grammy";
import {
  answerSchema,
  approvalEventSchema,
  decodeCallback,
  extractRequestId,
  generateShortId,
  getRemoteMode,
  hashToolArgs,
  parseOptions,
  redactArgs,
  redisKeys,
  resolveApproval,
  verifySharedSecret,
  type Answer,
  type ChoiceOption,
} from "@hitl/shared-types";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { approvalWebhookOutcomes } from "../metrics.js";

type Redis = import("ioredis").Redis;

type WebhookContext = {
  bot: Bot;
  redis: Redis;
  queues: import("../queues.js").GatewayQueues;
};

type RouteContext = WebhookContext & {
  app: FastifyInstance;
  reply: FastifyReply;
};

type TelegramUpdate = {
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      text?: string;
      chat?: { id: number };
      message_id?: number;
      message_thread_id?: number;
    };
    from: { id: number; username?: string; first_name?: string };
  };
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    text?: string;
    message_thread_id?: number;
    from?: { id: number; username?: string; first_name?: string };
  };
};

const MAX_ANSWER_LENGTH = 2000;

export function telegramWebhookRoutes({ bot, redis, queues }: WebhookContext) {
  return async (app: FastifyInstance) => {
    app.post("/v1/webhooks/telegram", async (req, reply) => {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      const provided = Array.isArray(header) ? header[0] : header;
      if (!verifySharedSecret(provided, config.telegramWebhookSecret)) {
        approvalWebhookOutcomes.inc({ outcome: "unauthorized" });
        return reply.code(401).send({ error: "Unauthorized webhook origin" });
      }

      const update = (req.body ?? {}) as TelegramUpdate;
      const ctx: RouteContext = { app, bot, redis, queues, reply };

      if (update.message) {
        return handleTextAnswer(ctx, update);
      }
      if (update.callback_query) {
        return handleCallback(ctx, update);
      }
      return reply.code(200).send({ ok: true });
    });
  };
}

async function handleChoiceCallback(
  ctx: RouteContext,
  cb: NonNullable<TelegramUpdate["callback_query"]>,
  shortId: string,
  index: number,
): Promise<FastifyReply> {
  const { app, bot, redis, queues, reply } = ctx;
  const actorId = cb.from.id;
  const actorUsername = cb.from.username ?? cb.from.first_name ?? null;
  const state = await redis.hgetall(redisKeys.request(shortId));

  if (state.status !== "PENDING" || state.kind !== "CHOICE") {
    if (state.status && state.status !== "PENDING") {
      approvalWebhookOutcomes.inc({ outcome: "already_resolved" });
      await bot.api
        .answerCallbackQuery(cb.id, {
          text: `ℹ️ Already marked as ${state.status}.`,
          show_alert: true,
        })
        .catch(() => undefined);
    } else {
      approvalWebhookOutcomes.inc({ outcome: "not_found" });
      await bot.api
        .answerCallbackQuery(cb.id, {
          text: "⚠️ Request expired or no longer exists.",
          show_alert: true,
        })
        .catch(() => undefined);
    }
    return reply.code(200).send({ ok: true });
  }

  if (state.phase === "awaiting_followup") {
    await bot.api
      .answerCallbackQuery(cb.id, {
        text: "ℹ️ Option already selected — please answer the follow-up question.",
      })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  const options = parseOptions(state.options);
  const option: ChoiceOption | undefined = options?.[index];
  if (!option) {
    await bot.api
      .answerCallbackQuery(cb.id, { text: "⚠️ Unknown option.", show_alert: true })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  const nowIso = new Date().toISOString();

  if (option.followUpPrompt) {
    await redis.hset(redisKeys.request(shortId), {
      phase: "awaiting_followup",
      selectedIndex: String(index),
      followUpPrompt: option.followUpPrompt,
    });
    if (cb.message?.text && cb.message.chat && cb.message.message_id != null) {
      await bot.api
        .editMessageText(String(cb.message.chat.id), cb.message.message_id, cb.message.text, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => undefined);
    }
    const followUpText = `${option.followUpPrompt}\n\n(Selected: ${option.label})\n→ Reply with "[${shortId}] <your answer>". Messages without this request ID are ignored.`;
    await bot.api.sendMessage(String(state.chatId), followUpText).catch(() => undefined);
    await bot.api.answerCallbackQuery(cb.id, { text: `✓ ${option.label}` }).catch(() => undefined);
    approvalWebhookOutcomes.inc({ outcome: "followup_sent" });
    app.log.info({ shortId, optionId: option.id }, "follow-up question sent");
    return reply.code(200).send({ ok: true });
  }

  const finalAnswer: Answer = {
    type: "choice",
    optionId: option.id,
    label: option.label,
    index,
  };
  const answerJson = JSON.stringify(answerSchema.parse(finalAnswer));

  const outcome = await resolveApproval(
    redis,
    shortId,
    "ANSWERED",
    String(actorId),
    null,
    nowIso,
    answerJson,
  );

  if (!outcome.ok && outcome.error === "NOT_FOUND") {
    approvalWebhookOutcomes.inc({ outcome: "not_found" });
    await bot.api
      .answerCallbackQuery(cb.id, {
        text: "⚠️ Request expired or no longer exists.",
        show_alert: true,
      })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  if (!outcome.ok && outcome.error === "ALREADY_RESOLVED") {
    approvalWebhookOutcomes.inc({ outcome: "already_resolved" });
    await bot.api
      .answerCallbackQuery(cb.id, {
        text: `ℹ️ Already marked as ${outcome.status}.`,
        show_alert: true,
      })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  if (!outcome.ok) {
    approvalWebhookOutcomes.inc({ outcome: "unknown_error" });
    app.log.error({ shortId, raw: outcome.raw }, "unexpected lua result");
    return reply.code(500).send({ error: "Failed to resolve request" });
  }

  approvalWebhookOutcomes.inc({ outcome: "answered" });
  await queues.ttl.remove(`ttl-${shortId}`).catch(() => undefined);
  if (state.chatId) {
    await redis.srem(redisKeys.chatIndex(String(state.chatId)), shortId).catch(() => undefined);
  }
  await queues.resolution.add(
    "process-resolution",
    {
      shortId,
      newStatus: "ANSWERED",
      actorId: String(actorId),
      actorUsername,
      resolvedAt: nowIso,
      reason: null,
      answerJson,
    },
    { jobId: `res-${shortId}` },
  );

  await bot.api.answerCallbackQuery(cb.id, { text: `✓ ${option.label}` }).catch(() => undefined);
  app.log.info({ shortId, optionId: option.id, actorId }, "choice answered via inline button");
  return reply.code(200).send({ ok: true });
}

async function handleCallback(ctx: RouteContext, update: TelegramUpdate): Promise<FastifyReply> {
  const { app, bot, redis, queues, reply } = ctx;
  const cb = update.callback_query!;
  const actorId = cb.from.id;
  const actorUsername = cb.from.username ?? cb.from.first_name ?? null;

  if (!config.allowedTelegramIds.includes(actorId)) {
    approvalWebhookOutcomes.inc({ outcome: "forbidden_actor" });
    await bot.api
      .answerCallbackQuery(cb.id, {
        text: "⛔ Unauthorized: your Telegram ID is not in the approver whitelist.",
        show_alert: true,
      })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  const parsedCallback = decodeCallback(cb.data);
  if (!parsedCallback) return reply.code(200).send({ ok: true });

  if (parsedCallback.action === "choice") {
    return handleChoiceCallback(ctx, cb, parsedCallback.shortId, parsedCallback.index);
  }

  const { shortId } = parsedCallback;
  const nowIso = new Date().toISOString();

  const newStatus = parsedCallback.action === "deny" ? "DENIED" : "APPROVED";
  const finalAnswer: Answer = { type: "approval", decision: newStatus };
  const answerJson = JSON.stringify(answerSchema.parse(finalAnswer));

  const outcome = await resolveApproval(
    redis,
    shortId,
    newStatus,
    String(actorId),
    null,
    nowIso,
    answerJson,
  );

  if (!outcome.ok && outcome.error === "NOT_FOUND") {
    approvalWebhookOutcomes.inc({ outcome: "not_found" });
    await bot.api
      .answerCallbackQuery(cb.id, {
        text: "⚠️ Request expired or no longer exists.",
        show_alert: true,
      })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  if (!outcome.ok && outcome.error === "ALREADY_RESOLVED") {
    approvalWebhookOutcomes.inc({ outcome: "already_resolved" });
    await bot.api
      .answerCallbackQuery(cb.id, {
        text: `ℹ️ Already marked as ${outcome.status}.`,
        show_alert: true,
      })
      .catch(() => undefined);
    return reply.code(200).send({ ok: true });
  }

  if (!outcome.ok) {
    approvalWebhookOutcomes.inc({ outcome: "unknown_error" });
    app.log.error({ shortId, raw: outcome.raw }, "unexpected lua result");
    return reply.code(500).send({ error: "Failed to resolve request" });
  }

  approvalWebhookOutcomes.inc({ outcome: newStatus.toLowerCase() });

  await queues.ttl.remove(`ttl-${shortId}`).catch(() => undefined);
  const state = await redis.hgetall(redisKeys.request(shortId));
  if (state.chatId) {
    await redis.srem(redisKeys.chatIndex(String(state.chatId)), shortId).catch(() => undefined);
  }
  await queues.resolution.add(
    "process-resolution",
    {
      shortId,
      newStatus,
      actorId: String(actorId),
      actorUsername,
      resolvedAt: nowIso,
      reason: null,
      answerJson,
    },
    { jobId: `res-${shortId}` },
  );

  await bot.api
    .answerCallbackQuery(cb.id, { text: acknowledgment(newStatus) })
    .catch(() => undefined);

  app.log.info({ shortId, newStatus, actorId }, "request resolved via telegram");
  return reply.code(200).send({ ok: true });
}

async function handleTextAnswer(ctx: RouteContext, update: TelegramUpdate): Promise<FastifyReply> {
  const { app, redis, queues, reply } = ctx;
  const message = update.message!;
  const from = message.from;
  const text = message.text?.trim();

  if (!from || !text) return reply.code(200).send({ ok: true });

  if (!config.allowedTelegramIds.includes(from.id)) {
    approvalWebhookOutcomes.inc({ outcome: "forbidden_actor" });
    return reply.code(200).send({ ok: true });
  }

  const extracted = extractRequestId(text);
  if (!extracted) {
    const done = await handleOperatorSteering(ctx, message, from, text);
    if (done) approvalWebhookOutcomes.inc({ outcome: "steered" });
    return reply.code(200).send({ ok: true });
  }

  const { shortId, answerText } = extracted;
  if (!answerText) return reply.code(200).send({ ok: true });

  const state = await redis.hgetall(redisKeys.request(shortId));
  if (state.status !== "PENDING") return reply.code(200).send({ ok: true });

  const isQuestion = state.kind === "QUESTION";
  const isFollowUp = state.phase === "awaiting_followup";
  if (!isQuestion && !isFollowUp) return reply.code(200).send({ ok: true });

  const actorUsername = from.username ?? from.first_name ?? null;
  const nowIso = new Date().toISOString();
  const sanitized = sanitizeAnswerText(answerText);

  let finalAnswer: Answer;
  if (isFollowUp) {
    const options = parseOptions(state.options);
    const index = Number.parseInt(state.selectedIndex ?? "", 10);
    const option: ChoiceOption | undefined = options?.[index];
    if (!option) return reply.code(200).send({ ok: true });
    finalAnswer = {
      type: "choice",
      optionId: option.id,
      label: option.label,
      index,
      followUpPrompt: state.followUpPrompt || option.followUpPrompt || "",
      followUpText: sanitized,
    };
  } else {
    finalAnswer = { type: "text", text: sanitized };
  }

  const answerJson = JSON.stringify(answerSchema.parse(finalAnswer));

  const outcome = await resolveApproval(
    redis,
    shortId,
    "ANSWERED",
    String(from.id),
    null,
    nowIso,
    answerJson,
  );

  if (!outcome.ok) {
    approvalWebhookOutcomes.inc({
      outcome: outcome.error === "ALREADY_RESOLVED" ? "already_resolved" : "not_found",
    });
    return reply.code(200).send({ ok: true });
  }

  approvalWebhookOutcomes.inc({ outcome: "answered" });
  await queues.ttl.remove(`ttl-${shortId}`).catch(() => undefined);
  await redis.srem(redisKeys.chatIndex(String(message.chat.id)), shortId).catch(() => undefined);
  await queues.resolution.add(
    "process-resolution",
    {
      shortId,
      newStatus: "ANSWERED",
      actorId: String(from.id),
      actorUsername,
      resolvedAt: nowIso,
      reason: null,
      answerJson,
    },
    { jobId: `res-${shortId}` },
  );

  app.log.info(
    { shortId, actorId: from.id, followUp: isFollowUp },
    "answered via telegram reply",
  );
  return reply.code(200).send({ ok: true });
}

async function handleOperatorSteering(
  ctx: RouteContext,
  message: NonNullable<TelegramUpdate["message"]>,
  actor: NonNullable<NonNullable<TelegramUpdate["message"]>["from"]>,
  text: string,
): Promise<boolean> {
  const { app, bot, redis, queues } = ctx;
  const chatId = String(message.chat.id);
  const inTopicId = message.message_thread_id ? String(message.message_thread_id) : null;

  const remote = await getRemoteMode(redis);
  if (!remote.enabled) return false;

  let agentId: string | null;
  let threadId: string | null;

  if (inTopicId) {
    const mapping = await redis.hgetall(redisKeys.remoteTopicMap(chatId, inTopicId));
    agentId = mapping.agentId || null;
    threadId = mapping.threadId || null;
    if (!agentId) return false;
  } else {
    agentId = remote.agentId;
    threadId = remote.threadId;
  }

  if (!agentId) {
    await bot.api
      .sendMessage(
        chatId,
        "🛰 Remote mode is ON but no agent session is bound. Re-trigger remote mode from the PC with an agentId.",
        { link_preview_options: { is_disabled: true } },
      )
      .catch(() => undefined);
    return false;
  }

  const sessionThreadId = threadId ?? `remote-${agentId}`;
  const shortId = generateShortId();
  const nowIso = new Date().toISOString();
  const actorUsername = actor.username ?? actor.first_name ?? null;

  let callbackUrl = remote.callbackUrl;
  if (!callbackUrl) {
    const lastRow = await prisma.approval_requests.findFirst({
      where: { agent_id: agentId, callback_url: { not: null } },
      orderBy: { created_at: "desc" },
      select: { callback_url: true },
    });
    callbackUrl = lastRow?.callback_url ?? null;
  }

  const toolArgs = { message: text };
  const argsHash = hashToolArgs(toolArgs);
  const redacted = redactArgs(toolArgs);
  const finalAnswer: Answer = {
    type: "text",
    text: text.slice(0, MAX_ANSWER_LENGTH),
  };

  try {
    await prisma.approval_requests.create({
      data: {
        short_id: shortId,
        idempotency_key: `op-${shortId}`,
        agent_id: agentId,
        thread_id: sessionThreadId,
        tool_name: "operator_message",
        tool_args_redacted: redacted as Prisma.InputJsonValue,
        tool_args_hash: argsHash,
        risk: "LOW",
        kind: "QUESTION",
        status: "ANSWERED",
        prompt: text.slice(0, 2000),
        answer_json: finalAnswer,
        resolution_reason: "operator steering (remote mode)",
        resolved_by_telegram_id: BigInt(actor.id),
        resolved_by_username: actorUsername,
        resolved_at: new Date(nowIso),
        telegram_chat_id: BigInt(chatId),
        telegram_thread_id: inTopicId ? BigInt(inTopicId) : null,
        callback_url: callbackUrl,
        expires_at: new Date(Date.parse(nowIso) + 300_000),
      },
    });
  } catch (error) {
    app.log.error({ err: error, shortId }, "failed to persist operator steering message");
    return false;
  }

  await bot.api
    .sendMessage(chatId, `🛰 → ${agentId} · ${sessionThreadId}\n[${shortId}]`, {
      link_preview_options: { is_disabled: true },
      ...(inTopicId ? { message_thread_id: Number(inTopicId) } : {}),
    })
    .catch(() => undefined);

  if (callbackUrl) {
    await queues.resume
      .add(
        "resume-agent",
        { shortId },
        { jobId: `resume-${shortId}-ANSWERED` },
      )
      .catch((error) => app.log.error({ err: error, shortId }, "failed to enqueue steering resume"));
  }

  app.log.info(
    { shortId, agentId, threadId, actorId: actor.id, callbackUrl },
    "operator steering delivered",
  );
  return true;
}


function acknowledgment(status: "APPROVED" | "DENIED"): string {
  return status === "APPROVED" ? "✅ Approved" : "❌ Denied";
}

function sanitizeAnswerText(text: string): string {
  const trimmed = text.slice(0, MAX_ANSWER_LENGTH);
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(redactArgs(parsed));
    }
  } catch {
    // not JSON — keep raw text
  }
  return trimmed;
}

export async function publishEvent(redis: Redis, shortId: string, event: unknown): Promise<void> {
  const parsed = approvalEventSchema.parse(event);
  await redis.publish(redisKeys.events(shortId), JSON.stringify(parsed));
}
