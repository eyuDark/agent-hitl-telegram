import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import {
  cancelApprovalSchema,
  createApprovalRequestSchema,
  generateShortId,
  getRemoteMode,
  hashToolArgs,
  hashToView,
  listApprovalsQuerySchema,
  redactArgs,
  redisKeys,
  resolveApproval,
  type ApprovalView,
  type RequestHashData,
} from "@hitl/shared-types";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { approvalsCreated, approvalWebhookOutcomes } from "../metrics.js";
import { requireApiKey, toView } from "../lib/views.js";

type AppContext = {
  redis: import("ioredis").Redis;
  queues: import("../queues.js").GatewayQueues;
};

export function approvalRoutes({ redis, queues }: AppContext) {
  return async (app: FastifyInstance) => {
    app.post("/v1/approvals", { preHandler: requireApiKey }, async (req, reply) => {
      const parsed = createApprovalRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid approval request",
          issues: parsed.error.issues,
        });
      }
      const body = parsed.data;

      const existing = await prisma.approval_requests.findUnique({
        where: { idempotency_key: body.idempotencyKey },
      });
      if (existing) {
        if (existing.status === "PENDING") {
          const remainingMs = existing.expires_at.getTime() - Date.now();
          if (remainingMs > 0) {
            await queues.dispatch.add(
              "dispatch",
              { shortId: existing.short_id },
              { jobId: `dispatch-${existing.short_id}` },
            );
            await queues.ttl.add(
              "expire",
              { shortId: existing.short_id },
              { jobId: `ttl-${existing.short_id}`, delay: remainingMs },
            );
          }
        }
        return reply.code(200).send(toView(existing));
      }

      const shortId = generateShortId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + body.ttlSeconds * 1000);
      const toolArgs = body.toolArgs ?? null;
      const argsHash = hashToolArgs(toolArgs);
      const redacted = redactArgs(toolArgs);

      const remote = await getRemoteMode(redis);
      let chatId = body.telegramChatId ?? config.defaultTelegramChatId;
      let hotTopicId: string | null = null;
      if (!body.telegramChatId && remote.enabled) {
        if (remote.chatId) chatId = remote.chatId;
        hotTopicId = remote.topicId ?? null;
      }

      const callbackUrl = body.callbackUrl ?? null;

      let row;
      try {
        row = await prisma.approval_requests.create({
          data: {
            short_id: shortId,
            idempotency_key: body.idempotencyKey,
            agent_id: body.agentId,
            thread_id: body.threadId,
            tool_name: body.toolName,
            tool_args_redacted: redacted as Prisma.InputJsonValue,
            tool_args_hash: argsHash,
            risk: body.risk,
            kind: body.kind,
            prompt: body.prompt ?? null,
            options_json: body.options ? (body.options as Prisma.InputJsonValue) : undefined,
            reason: body.reason ?? null,
            telegram_chat_id: BigInt(chatId),
            telegram_thread_id: hotTopicId ? BigInt(hotTopicId) : null,
            callback_url: callbackUrl,
            expires_at: expiresAt,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const raced = await prisma.approval_requests.findUnique({
            where: { idempotency_key: body.idempotencyKey },
          });
          if (raced) return reply.code(200).send(toView(raced));
        }
        throw error;
      }

      const key = redisKeys.request(shortId);
      await redis
        .multi()
        .hset(key, {
          id: row.id,
          shortId,
          status: "PENDING",
          kind: body.kind,
          agentId: body.agentId,
          threadId: body.threadId,
          toolName: body.toolName,
          risk: body.risk,
          argsHash,
          redactedArgs: JSON.stringify(redacted ?? null),
          prompt: body.prompt ?? "",
          options: body.options ? JSON.stringify(body.options) : "",
          answerJson: "",
          phase: body.kind === "CHOICE" ? "selection" : "",
          selectedIndex: "",
          followUpPrompt: "",
          reason: body.reason ?? "",
          callbackUrl: callbackUrl ?? "",
          chatId,
          chatTopicId: hotTopicId ?? "",
          messageId: "",
          originalText: "",
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          actorId: "",
          actorUsername: "",
          resolvedAt: "",
          resolutionReason: "",
        })
        .expire(key, body.ttlSeconds + 300)
        .exec();

      await queues.dispatch.add(
        "dispatch",
        { shortId },
        { jobId: `dispatch-${shortId}` },
      );
      await queues.ttl.add(
        "expire",
        { shortId },
        { jobId: `ttl-${shortId}`, delay: body.ttlSeconds * 1000 },
      );

      approvalsCreated.inc({ risk: body.risk });
      app.log.info(
        { shortId, toolName: body.toolName, agentId: body.agentId },
        "approval request created",
      );

      return reply.code(201).send(toView(row));
    });

    app.get<{ Params: { shortId: string } }>(
      "/v1/approvals/:shortId",
      { preHandler: requireApiKey },
      async (req, reply) => {
        const { shortId } = req.params;
        const hash = await redis.hgetall(redisKeys.request(shortId));
        if (hash.status && hash.risk && hash.createdAt) {
          return reply.send(hashToView(hash as unknown as RequestHashData));
        }

        const row = await prisma.approval_requests.findUnique({ where: { short_id: shortId } });
        if (!row) return reply.code(404).send({ error: "Approval request not found" });
        return reply.send(toView(row));
      },
    );

    app.get("/v1/approvals", { preHandler: requireApiKey }, async (req, reply) => {
      const parsed = listApprovalsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid query", issues: parsed.error.issues });
      }
      const { threadId, agentId, status, limit } = parsed.data;
      const rows = await prisma.approval_requests.findMany({
        where: {
          ...(threadId ? { thread_id: threadId } : {}),
          ...(agentId ? { agent_id: agentId } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: { created_at: "desc" },
        take: limit,
      });
      return reply.send(rows.map(toView));
    });

    app.get<{ Params: { shortId: string } }>(
      "/v1/approvals/:shortId/events",
      { preHandler: requireApiKey },
      async (req, reply) => {
        const { shortId } = req.params;
        const row = await prisma.approval_requests.findUnique({
          where: { short_id: shortId },
          select: { status: true, short_id: true },
        });
        if (!row) return reply.code(404).send({ error: "Approval request not found" });

        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        const write = (payload: unknown) => {
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        write({ shortId, status: row.status, occurredAt: new Date().toISOString() });

        if (row.status !== "PENDING") {
          reply.raw.end();
          return;
        }

        const subscriber = redis.duplicate();
        const channel = redisKeys.events(shortId);
        let closed = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          subscriber.quit().catch(() => undefined);
          reply.raw.end();
        };

        const onMessage = (_channel: string, message: string) => {
          try {
            write(JSON.parse(message));
          } catch {
            write({ shortId, status: "UNKNOWN", occurredAt: new Date().toISOString() });
          }
          cleanup();
        };

        subscriber.on("message", onMessage);
        await subscriber.subscribe(channel);

        const heartbeat = setInterval(() => {
          if (!closed) reply.raw.write(": ping\n\n");
        }, 15_000);

        req.raw.on("close", () => {
          clearInterval(heartbeat);
          subscriber.removeListener("message", onMessage);
          cleanup();
        });
      },
    );

    app.post<{ Params: { shortId: string } }>(
      "/v1/approvals/:shortId/cancel",
      { preHandler: requireApiKey },
      async (req, reply) => {
        const parsed = cancelApprovalSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: "Invalid cancel payload" });
        }
        const { shortId } = req.params;

        const outcome = await resolveApproval(
          redis,
          shortId,
          "CANCELLED",
          "AGENT",
          parsed.data.reason ?? null,
        );

        if (!outcome.ok && outcome.error === "NOT_FOUND") {
          return reply.code(404).send({ error: "Approval request not found" });
        }

        if (!outcome.ok && outcome.error === "ALREADY_RESOLVED") {
          return reply.code(409).send({
            error: "Approval request already resolved",
            status: outcome.status,
          });
        }

        if (outcome.ok) {
          await queues.ttl.remove(`ttl-${shortId}`);
          const state = await redis.hgetall(redisKeys.request(shortId));
          if (state.chatId) {
            await redis
              .srem(redisKeys.chatIndex(String(state.chatId)), shortId)
              .catch(() => undefined);
          }
          await queues.resolution.add(
            "process-resolution",
            {
              shortId,
              newStatus: "CANCELLED",
              actorId: "AGENT",
              actorUsername: null,
              resolvedAt: new Date().toISOString(),
              reason: parsed.data.reason ?? null,
              answerJson: null,
            },
            { jobId: `res-${shortId}` },
          );
          approvalWebhookOutcomes.inc({ outcome: "cancelled" });

          // The resolution worker will write the same values; do it now so the
          // cancel response isn't racing the async DB update.
          await prisma.approval_requests
            .update({
              where: { short_id: shortId },
              data: {
                status: "CANCELLED",
                resolved_at: new Date(),
                resolution_reason: parsed.data.reason ?? null,
              },
            })
            .catch(() => undefined);
        }

        const row = await prisma.approval_requests.findUnique({ where: { short_id: shortId } });
        if (!row) return reply.code(404).send({ error: "Approval request not found" });
        return reply.send(toView(row));
      },
    );
  };
}
