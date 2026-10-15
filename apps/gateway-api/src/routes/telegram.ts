import type { FastifyInstance, FastifyReply } from "fastify";
import { Bot } from "grammy";
import {
  answerSchema,
  approvalEventSchema,
  decodeCallback,
  parseOptions,
  redactArgs,
  redisKeys,
  resolveApproval,
  verifySharedSecret,
  type Answer,
  type ChoiceOption,
} from "@hitl/shared-types";
import { config } from "../config.js";
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
    message?: { text?: string; chat?: { id: number }; message_id?: number };
    from: { id: number; username?: string; first_name?: string };
  };
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
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

      if (update.message?.reply_to_message) {
        return handleTextReply(ctx, update);
      }
      if (update.message) {
        return handleSelectionText(ctx, update);
      }
      if (update.callback_query) {
        return handleCallback(ctx, update);
      }
      return reply.code(200).send({ ok: true });
    });
  };
}

async function handleSelectionText(
  ctx: RouteContext,
  update: TelegramUpdate,
): Promise<FastifyReply> {
  const { app, bot, redis, queues, reply } = ctx;
  const message = update.message!;
  const from = message.from;
  const text = message.text?.trim();

  if (!from || !text || !config.allowedTelegramIds.includes(from.id)) {
    if (from && !config.allowedTelegramIds.includes(from.id)) {
      approvalWebhookOutcomes.inc({ outcome: "forbidden_actor" });
    }
    return reply.code(200).send({ ok: true });
  }

  const members = await redis.smembers(redisKeys.chatIndex(String(message.chat.id)));

  for (const shortId of members) {
    const state = await redis.hgetall(redisKeys.request(shortId));
    if (
      state.status !== "PENDING" ||
      state.kind !== "CHOICE" ||
      state.phase === "awaiting_followup"
    ) {
      continue;
    }

    const options = parseOptions(state.options);
    if (!options) continue;
    const index = options.findIndex((option) => option.label === text);
    if (index < 0) continue;

    const option = options[index] as ChoiceOption;
    const actorUsername = from.username ?? from.first_name ?? null;
    const nowIso = new Date().toISOString();

    if (option.followUpPrompt) {
      await redis.hset(redisKeys.request(shortId), {
        phase: "awaiting_followup",
        selectedIndex: String(index),
        followUpPrompt: option.followUpPrompt,
      });
      const followUpText = `${option.followUpPrompt}\n\n(Selected: ${option.label})\n→ Reply to this message to answer.`;
      const followUpMessage = await bot.api.sendMessage(String(state.chatId), followUpText, {
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Type your answer…",
        },
      });
      await redis.set(
        redisKeys.messageIndex(String(state.chatId), followUpMessage.message_id),
        shortId,
        "EX",
        86_400,
      );
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

    app.log.info({ shortId, optionId: option.id }, "choice answered via keyboard selection");
    return reply.code(200).send({ ok: true });
  }

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

async function handleTextReply(ctx: RouteContext, update: TelegramUpdate): Promise<FastifyReply> {
  const { app, redis, queues, reply } = ctx;
  const message = update.message!;
  const from = message.from;

  if (!from || !config.allowedTelegramIds.includes(from.id)) {
    approvalWebhookOutcomes.inc({ outcome: "forbidden_actor" });
    return reply.code(200).send({ ok: true });
  }

  const repliedMessageId = message.reply_to_message?.message_id;
  const text = message.text?.trim();
  if (!repliedMessageId || !text) return reply.code(200).send({ ok: true });

  const shortId = await redis.get(
    redisKeys.messageIndex(String(message.chat.id), String(repliedMessageId)),
  );
  if (!shortId) return reply.code(200).send({ ok: true });

  const state = await redis.hgetall(redisKeys.request(shortId));
  if (state.status !== "PENDING") return reply.code(200).send({ ok: true });

  const isQuestion = state.kind === "QUESTION";
  const isFollowUp = state.phase === "awaiting_followup";
  if (!isQuestion && !isFollowUp) return reply.code(200).send({ ok: true });

  const actorUsername = from.username ?? from.first_name ?? null;
  const nowIso = new Date().toISOString();
  const sanitized = sanitizeAnswerText(text);

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
