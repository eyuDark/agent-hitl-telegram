import { Bot } from "grammy";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createRedisConnection } from "./redis.js";
import { createQueues } from "./queues.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const redis = createRedisConnection(config.redisUrl);
  const bot = new Bot(config.telegramBotToken);
  const queues = createQueues(redis);
  const app = buildApp({ redis, queues, bot });

  await prisma.$connect();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, approvers: config.allowedTelegramIds.length },
    "gateway api listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down gateway");
    await app.close();
    await Promise.all([
      queues.dispatch.close(),
      queues.ttl.close(),
      queues.resolution.close(),
      queues.resume.close(),
    ]);
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal gateway startup error", error);
  process.exit(1);
});
