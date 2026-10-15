import type { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import {
  approvalEventSchema,
  decodeCallback,
  redisKeys,
  resolveApproval,
  verifySharedSecret,
} from "@hitl/shared-types";
import { config } from "../config.js";
import { approvalWebhookOutcomes } from "../metrics.js";

type WebhookContext = {
  bot: Bot;
  redis: import("ioredis").Redis;
  queues: import("../queues.js").GatewayQueues;
};

export function telegramWebhookRoutes({ bot, redis, queues }: WebhookContext) {
  return async (app: FastifyInstance) => {
    app.post("/v1/webhooks/telegram", async (req, reply) => {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      const provided = Array.isArray(header) ? header[0] : header;
      if (!verifySharedSecret(provided, config.telegramWebhookSecret)) {
        approvalWebhookOutcomes.inc({ outcome: "unauthorized" });
        return reply.code(401).send({ error: "Unauthorized webhook origin" });
      }

      const update = req.body as {
        callback_query?: {
          id: string;
          data?: string;
          message?: { text?: string; chat?: { id: number }; message_id?: number };
          from: { id: number; username?: string; first_name?: string };
        };
      };

      const cb = update?.callback_query;
      if (!cb) return reply.code(200).send({ ok: true });

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

      const { action, shortId } = parsedCallback;
      const newStatus = action === "approve" ? ("APPROVED" as const) : ("DENIED" as const);
      const nowIso = new Date().toISOString();

      const outcome = await resolveApproval(redis, shortId, newStatus, String(actorId), null, nowIso);

      if (!outcome.ok && outcome.error === "NOT_FOUND") {
        approvalWebhookOutcomes.inc({ outcome: "not_found" });
        await bot.api
          .answerCallbackQuery(cb.id, {
            text: "⚠️ Approval request expired or no longer exists.",
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
        return reply.code(500).send({ error: "Failed to resolve approval" });
      }

      approvalWebhookOutcomes.inc({ outcome: newStatus.toLowerCase() });

      await queues.ttl.remove(`ttl-${shortId}`).catch(() => undefined);
      await queues.resolution.add(
        "process-resolution",
        {
          shortId,
          newStatus,
          actorId: String(actorId),
          actorUsername,
          resolvedAt: nowIso,
          reason: null,
        },
        { jobId: `res-${shortId}` },
      );

      await bot.api
        .answerCallbackQuery(cb.id, {
          text: newStatus === "APPROVED" ? "✅ Approved" : "❌ Denied",
        })
        .catch(() => undefined);

      app.log.info({ shortId, newStatus, actorId }, "approval resolved via telegram");
      return reply.code(200).send({ ok: true });
    });
  };
}

export async function publishEvent(
  redis: import("ioredis").Redis,
  shortId: string,
  event: unknown,
): Promise<void> {
  const parsed = approvalEventSchema.parse(event);
  await redis.publish(redisKeys.events(shortId), JSON.stringify(parsed));
}
