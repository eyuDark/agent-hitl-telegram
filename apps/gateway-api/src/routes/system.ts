import type { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import { taskCompleteSchema } from "@hitl/shared-types";
import { config } from "../config.js";
import { registry } from "../metrics.js";
import { requireApiKey } from "../lib/views.js";

export function systemRoutes(bot: Bot) {
  return async (app: FastifyInstance) => {
    app.get("/healthz", async () => ({ status: "ok" }));

    app.get("/metrics", async (_req, reply) => {
      const metrics = await registry.metrics();
      reply.header("content-type", registry.contentType);
      return reply.send(metrics);
    });

    app.post("/v1/admin/telegram/set-webhook", { preHandler: requireApiKey }, async (req, reply) => {
      if (!config.publicBaseUrl) {
        return reply
          .code(400)
          .send({ error: "PUBLIC_BASE_URL must be configured to set the webhook" });
      }
      const url = `${config.publicBaseUrl.replace(/\/+$/, "")}/v1/webhooks/telegram`;
      const result = await bot.api.setWebhook(url, {
        secret_token: config.telegramWebhookSecret,
        drop_pending_updates: false,
      });
      return reply.send({ ok: result, url });
    });

    app.get("/v1/admin/telegram/webhook-info", { preHandler: requireApiKey }, async (_req, reply) => {
      const info = await bot.api.getWebhookInfo();
      return reply.send(info);
    });

    app.post("/v1/notifications/task-complete", { preHandler: requireApiKey }, async (req, reply) => {
      const parsed = taskCompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid payload", issues: parsed.error.issues });
      }
      app.log.info(parsed.data, "agent task complete notification");
      return reply.code(202).send({ ok: true });
    });
  };
}
