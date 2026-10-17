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
  initQueues: import("../queues.js").GatewayQueues;
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

async function upsertSessionTopic(
  bot: Bot,
  redis: import("ioredis").Redis,
  chatId: string,
  agentId: string | undefined,
  threadId: string | undefined,
  sessionName: string | undefined,
  forceNewTopic: boolean | undefined,
): Promise<
  { ok: true; topicId: string; title: string; reused: boolean } | { ok: false; error: string }
> {
  const agent = agentId ?? "remote";
  const sessionThreadId = threadId ?? "session";
  const sessionKey = redisKeys.remoteSession(agent, sessionThreadId);
  const requestedTitle = sessionName?.trim() || `${agent} · ${sessionThreadId}`;
  const title = requestedTitle.slice(0, 96);
  const topicmapData = { agentId: agent, threadId: sessionThreadId };

  if (!forceNewTopic) {
    const previous = await redis.hgetall(sessionKey);
    const prevTopic = previous.topicId;
    if (prevTopic) {
      let reopenOk = false;
      try {
        await bot.api.reopenForumTopic(chatId, Number(prevTopic));
        reopenOk = true;
      } catch (error) {
        const message = (error as { message?: string }).message ?? String(error);
        if (/TOPIC_NOT_MODIFIED/i.test(message)) {
          reopenOk = true;
        } else {
          await redis.hdel(sessionKey, "topicId", "title");
        }
      }
      if (reopenOk) {
        if (sessionName?.trim() && previous.title && previous.title !== title) {
          await bot.api
            .editForumTopic(chatId, Number(prevTopic), { name: title })
            .catch(() => undefined);
        }
        await redis.hset(sessionKey, { status: "ACTIVE", disabledAt: "", title });
        await redis.hset(redisKeys.remoteTopicMap(chatId, prevTopic), topicmapData);
        return { ok: true, topicId: prevTopic, title, reused: true };
      }
    }
  }

  try {
    const topic = await bot.api.createForumTopic(chatId, title);
    const topicId = String(topic.message_thread_id);
    await redis.hset(sessionKey, {
      agentId: agent,
      threadId: sessionThreadId,
      chatId,
      topicId,
      title,
      status: "ACTIVE",
      enabledAt: new Date().toISOString(),
      disabledAt: "",
    });
    await redis.hset(redisKeys.remoteTopicMap(chatId, topicId), topicmapData);
    return { ok: true, topicId, title, reused: false };
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

export function remoteModeRoutes({ redis, bot, initQueues }: RemoteModeContext) {
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
        let webhookWarning: string | null = null;
        if (config.publicBaseUrl) {
          try {
            const probe = await fetch(new URL("/healthz", config.publicBaseUrl), {
              signal: AbortSignal.timeout(5_000),
            });
            if (!probe.ok) {
              webhookWarning = `PUBLIC_BASE_URL responded ${probe.status} — Telegram cannot deliver incoming events (approvals/steering).`;
            }
          } catch {
            webhookWarning =
              "PUBLIC_BASE_URL unreachable from the internet — Telegram cannot deliver incoming events (approvals/steering).";
          }
          // shortcut: probe only runs at toggle time, mid-session tunnel death still goes unnoticed
        }

        if (toggle.spawnTopic && !toggle.topicId) {
          const spawned = await upsertSessionTopic(
            bot,
            redis,
            chatId,
            toggle.agentId,
            toggle.threadId,
            toggle.sessionName,
            toggle.forceNewTopic,
          );
          if (!spawned.ok) {
            remoteModeToggles.inc({ state: "spawn_topic_failed" });
            app.log.error({ err: spawned.error }, "remote spawnTopic failed");
            return reply.code(400).send({ error: spawned.error });
          }
          toggle.topicId = spawned.topicId;
          app.log.info(
            { agentId: toggle.agentId, threadId: toggle.threadId, topicId: spawned.topicId, reused: spawned.reused, title: spawned.title },
            spawned.reused ? "remote session topic reopened" : "remote session topic created",
          );
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
            webhookWarning,
          },
          "remote mode toggled",
        );

        await initQueues.ttl.add(
          "remote-audit",
          {
            enabledAt: snapshot.enabledAt ?? "",
            chatId,
            topicId: snapshot.topicId,
            agentId: snapshot.agentId,
            threadId: snapshot.threadId,
          },
          {
            // dead-man: if this flag stays until the 24h audit TTL dies, close the topic
            jobId: `remote-audit-${Date.now()}`,
            delay: 24 * 60 * 60 * 1000,
            removeOnComplete: true,
          },
        );

        await bot.api
          .sendMessage(
            chatId,
            webhookWarning
              ? `⚠️ ${webhookWarning}\n\n${remoteSessionNotice(true, snapshot.agentId, snapshot.threadId)}`
              : remoteSessionNotice(true, snapshot.agentId, snapshot.threadId),
            {
              link_preview_options: { is_disabled: true },
              ...(snapshot.topicId
                ? { message_thread_id: Number(snapshot.topicId) }
                : {}),
            },
          )
          .catch(() => undefined);

        return reply.code(200).send({ ...snapshot, webhookWarning });
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
