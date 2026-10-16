import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { Bot } from "grammy";
import type { Redis } from "ioredis";
import { config } from "./config.js";
import { httpDuration } from "./metrics.js";
import { approvalRoutes } from "./routes/approvals.js";
import { telegramWebhookRoutes } from "./routes/telegram.js";
import { agentMessageRoutes } from "./routes/agent-messages.js";
import { remoteModeRoutes } from "./routes/remote.js";
import { systemRoutes } from "./routes/system.js";
import type { GatewayQueues } from "./queues.js";

export type BuildAppContext = {
  redis: Redis;
  queues: GatewayQueues;
  bot: Bot;
};

export function buildApp({ redis, queues, bot }: BuildAppContext): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.nodeEnv === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true } } }
        : {}),
    },
    bodyLimit: 1_048_576,
  });

  app.addHook("onResponse", async (request, reply) => {
    httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions?.url ?? request.url.split("?")[0] ?? "unknown",
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", issues: error.issues });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "Unique constraint violated" });
    }
    const err = error as { statusCode?: number; message?: string };
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message ?? "Request failed" });
    }
    app.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` }),
  );

  void app.register(systemRoutes(bot));
  void app.register(approvalRoutes({ redis, queues }));
  void app.register(telegramWebhookRoutes({ bot, redis, queues }));
  void app.register(agentMessageRoutes({ redis, queues }));
  void app.register(remoteModeRoutes({ redis, bot }));

  return app;
}
