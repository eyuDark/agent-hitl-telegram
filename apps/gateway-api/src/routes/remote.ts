import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";
import {
  getRemoteMode,
  redisKeys,
  remoteModeToggleSchema,
  setRemoteMode,
} from "@hitl/shared-types";
import { config } from "../config.js";
import { remoteModeToggles } from "../metrics.js";
import { requireApiKey } from "../lib/views.js";

type RemoteModeContext = {
  redis: import("ioredis").Redis;
  bot: Bot;
};

function remoteSessionNotice(
  enabled: boolean,
  agentId: string | null,
  threadId: string | null,
): string {
  if (enabled) {
    const target = agentId ? `\nAgent: ${agentId}${threadId ? `\nThread: ${threadId}` : ""}` : "";
    return `🛰 Remote mode ON — agent updates and operator steering now flow through this chat.${target}`;
  }
  return `🛰 Remote mode OFF — bot routing stopped. Pending expiry resumes at normal TTL cadence.`;
}

async function closeTopic(bot: Bot, chatId: string, topicId: string): Promise<void> {
  await bot.api
    .closeForumTopic(chatId, Number(topicId))
    .catch(() => undefined);
}

async function spawnTopic(
  bot: Bot,
  redis: import("ioredis").Redis,
  chatId: string,
  agentId: string | undefined,
  threadId: string | undefined,
): Promise<{ ok: true; topicId: string; title: string } | { ok: false; error: string }> {
  const title = `${agentId ?? "remote"} · ${threadId ?? "session"}`.slice(0, 96);
  try {
    const topic = await bot.api.createForumTopic(chatId, title);
    const topicId = String(topic.message_thread_id);
    await redis.hset(redisKeys.remoteSession(agentId ?? "remote", threadId ?? "session"), {
      agentId: agentId ?? "remote",
      threadId: threadId ?? "session",
      chatId,
      topicId,
      status: "ACTIVE",
      enabledAt: new Date().toISOString(),
      disabledAt: "",
    });
    await redis.hset(redisKeys.remoteTopicMap(chatId, topicId), {
      agentId: agentId ?? "remote",
      threadId: threadId ?? "session",
    });
    return { ok: true, topicId, title };
  } catch (error) {
    const message = (error as { message?: string }).message ?? String(error);
    return {
      ok: false,
      error:
        "createForumTopic failed — make sure the bound chat is a supergroup with Topics enabled " +
        `and the bot is a member. Telegram said: ${message}`,
    };
  }
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

      if (toggle.enabled) {
        if (toggle.spawnTopic && !toggle.topicId) {
          const spawned = await spawnTopic(
            bot,
            redis,
            chatId,
            toggle.agentId,
            toggle.threadId,
          );
          if (!spawned.ok) {
            remoteModeToggles.inc({ state: "spawn_topic_failed" });
            app.log.error({ err: spawned.error }, "remote spawnTopic failed");
            return reply.code(400).send({ error: spawned.error });
          }
          toggle.topicId = spawned.topicId;
        }

        const snapshot = await setRemoteMode(redis, {
          enabled: true,
          actor: "api",
          reason: toggle.reason ?? null,
          agentId: toggle.agentId ?? null,
          threadId: toggle.threadId ?? null,
          chatId,
          topicId: toggle.topicId ?? null,
          callbackUrl: toggle.callbackUrl ?? null,
        });

        remoteModeToggles.inc({ state: "on" });
        app.log.info(
          {
            enabled: true,
            agentId: snapshot.agentId,
            threadId: snapshot.threadId,
            chatId: snapshot.chatId,
            topicId: snapshot.topicId,
          },
          "remote mode toggled",
        );

        await bot.api
          .sendMessage(
            chatId,
            remoteSessionNotice(true, snapshot.agentId, snapshot.threadId),
            {
              link_preview_options: { is_disabled: true },
              ...(snapshot.topicId
                ? { message_thread_id: Number(snapshot.topicId) }
                : {}),
            },
          )
          .catch(() => undefined);

        return reply.code(200).send(snapshot);
      }

      const previous = await getRemoteMode(redis);
      const snapshot = await setRemoteMode(redis, {
        enabled: false,
        actor: "api",
        reason: toggle.reason ?? null,
      });

      remoteModeToggles.inc({ state: "off" });
      app.log.info({ enabled: false, agentId: previous.agentId }, "remote mode toggled");

      if (previous.enabled && previous.topicId && previous.chatId) {
        await closeTopic(bot, previous.chatId, previous.topicId);
        await redis
          .hset(
            redisKeys.remoteSession(
              previous.agentId ?? "remote",
              previous.threadId ?? "session",
            ),
            { status: "CLOSED", disabledAt: new Date().toISOString() },
          )
          .catch(() => undefined);
        await redis
          .del(redisKeys.remoteTopicMap(previous.chatId, previous.topicId))
          .catch(() => undefined);
      }

      const replyChat = previous.chatId ?? config.defaultTelegramChatId;
      await bot.api
        .sendMessage(replyChat, remoteSessionNotice(false, previous.agentId, previous.threadId), {
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);

      return reply.code(200).send(snapshot);
    });
  };
}
