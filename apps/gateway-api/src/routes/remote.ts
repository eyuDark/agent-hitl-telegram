import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";
import { getRemoteMode, remoteModeToggleSchema, setRemoteMode } from "@hitl/shared-types";
import { config } from "../config.js";
import { remoteModeToggles } from "../metrics.js";
import { requireApiKey } from "../lib/views.js";

type RemoteModeContext = {
  redis: import("ioredis").Redis;
  bot: Bot;
};

function remoteSessionNotice(enabled: boolean, agentId: string | null, threadId: string | null) {
  if (enabled) {
    const target = agentId ? `\nAgent: ${agentId}${threadId ? `\nThread: ${threadId}` : ""}` : "";
    return `🛰 Remote mode ON — agent updates and operator steering now flow through this chat.${target}`;
  }
  return `🛰 Remote mode OFF — bot routing stopped. Pending expiry resumes at normal TTL cadence.`;
}

export function remoteModeRoutes({ redis, bot }: RemoteModeContext) {
  return async (app: FastifyInstance) => {
    app.get("/v1/admin/remote-mode", { preHandler: requireApiKey }, async () => {
      return getRemoteMode(redis);
    });

    app.post("/v1/admin/remote-mode", { preHandler: requireApiKey }, async (req, reply) => {
      const parsed = remoteModeToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid remote mode toggle payload",
          issues: parsed.error.issues,
        });
      }
      const toggle = parsed.data;
      const chatId = toggle.chatId ?? config.defaultTelegramChatId;

      const snapshot = await setRemoteMode(redis, {
        enabled: toggle.enabled,
        actor: "api",
        reason: toggle.reason ?? null,
        agentId: toggle.agentId ?? null,
        threadId: toggle.threadId ?? null,
        chatId,
        callbackUrl: toggle.callbackUrl ?? null,
      });

      remoteModeToggles.inc({ state: toggle.enabled ? "on" : "off" });
      app.log.info(
        {
          enabled: toggle.enabled,
          agentId: snapshot.agentId,
          threadId: snapshot.threadId,
          chatId: snapshot.chatId,
        },
        "remote mode toggled",
      );

      await bot.api
        .sendMessage(
          chatId,
          remoteSessionNotice(toggle.enabled, snapshot.agentId, snapshot.threadId),
          { link_preview_options: { is_disabled: true } },
        )
        .catch(() => undefined);

      return reply.code(200).send(snapshot);
    });
  };
}
