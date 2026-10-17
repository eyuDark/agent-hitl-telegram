import type { FastifyInstance } from "fastify";
import {
  agentMessageSchema,
  generateShortId,
  getRemoteMode,
  operatorMessagesQuerySchema,
} from "@hitl/shared-types";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { agentOutboundEnqueued } from "../metrics.js";
import { requireApiKey } from "../lib/views.js";

type AgentMessageContext = {
  redis: import("ioredis").Redis;
  queues: import("../queues.js").GatewayQueues;
};

export function agentMessageRoutes({ redis, queues }: AgentMessageContext) {
  return async (app: FastifyInstance) => {
    app.post("/v1/notifications/agent-message", { preHandler: requireApiKey }, async (req, reply) => {
      const parsed = agentMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid agent message payload",
          issues: parsed.error.issues,
        });
      }
      const { agentId, threadId, message } = parsed.data;

      const remote = await getRemoteMode(redis);
      if (!remote.enabled) {
        agentOutboundEnqueued.inc({ outcome: "remote_off" });
        return reply.code(202).send({ ok: true, delivered: false, reason: "remote_mode_off" });
      }

      const chatId = remote.chatId ?? config.defaultTelegramChatId;
      await queues.outbound.add(
        "agent-outbound",
        {
          chatId,
          topicId: remote.topicId ?? null,
          agentId,
          threadId,
          message,
          createdAt: new Date().toISOString(),
        },
        { jobId: `out-${generateShortId()}` },
      );
      agentOutboundEnqueued.inc({ outcome: "enqueued" });
      app.log.info(
        { agentId, threadId, chatId, topicId: remote.topicId ?? null },
        "agent message queued for telegram",
      );

      return reply.code(202).send({ ok: true, delivered: true, chatId });
    });

    app.get("/v1/remote/messages", { preHandler: requireApiKey }, async (req, reply) => {
      const query = operatorMessagesQuerySchema.safeParse(req.query);
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid query",
          issues: query.error.issues,
        });
      }
      const { agentId, threadId, since, limit, waitSeconds } = query.data;
      const sinceDate = since
        ? new Date(since)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);

      const fetchRows = () =>
        prisma.approval_requests.findMany({
          where: {
            tool_name: "operator_message",
            status: "ANSWERED",
            ...(agentId ? { agent_id: agentId } : {}),
            ...(threadId ? { thread_id: threadId } : {}),
            created_at: { gt: sinceDate },
          },
          orderBy: { created_at: "asc" },
          take: limit,
        });

      let rows = await fetchRows();

      if (rows.length === 0 && waitSeconds > 0) {
        const deadline = Date.now() + waitSeconds * 1000;
        let clientGone = false;
        req.raw.on("close", () => {
          clientGone = true;
        });
        while (rows.length === 0 && !clientGone && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          if (clientGone) break;
          rows = await fetchRows();
        }
      }

      return reply.send(
        rows.map((row) => ({
          shortId: row.short_id,
          agentId: row.agent_id,
          threadId: row.thread_id,
          message:
            typeof row.answer_json === "object" &&
            row.answer_json !== null &&
            "text" in (row.answer_json as Record<string, unknown>)
              ? String((row.answer_json as Record<string, unknown>).text)
              : null,
          createdAt: row.created_at.toISOString(),
        })),
      );
    });

    app.get(
      "/v1/remote/callback-url/:agentId",
      { preHandler: requireApiKey },
      async (req, reply) => {
        const { agentId } = req.params as { agentId: string };
        const row = await prisma.approval_requests.findFirst({
          where: { agent_id: agentId, callback_url: { not: null } },
          orderBy: { created_at: "desc" },
          select: { callback_url: true },
        });
        return reply.send({ agentId, callbackUrl: row?.callback_url ?? null });
      },
    );
  };
}
