import { createServer } from "node:http";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createRedisConnection } from "./redis.js";
import { createQueues } from "./queues.js";
import { registry } from "./metrics.js";
import { createDispatchWorker } from "./workers/dispatch.worker.js";
import { createTtlWorker } from "./workers/ttl.worker.js";
import { createResolutionWorker } from "./workers/resolution.worker.js";
import { createResumeWorker } from "./workers/resume.worker.js";

async function main(): Promise<void> {
  const connection = createRedisConnection(config.redisUrl);
  const queues = createQueues(connection);

  await prisma.$connect();

  const workers = [
    createDispatchWorker(connection),
    createTtlWorker({ connection, resumeQueue: queues.resume }),
    createResolutionWorker({ connection, resumeQueue: queues.resume }),
    createResumeWorker(connection),
  ];

  for (const worker of workers) {
    worker.on("failed", (job, error) => {
      console.error(
        JSON.stringify({
          level: "error",
          queue: worker.name,
          jobId: job?.id,
          err: error.message,
        }),
      );
    });
  }

  const metricsServer = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      const body = await registry.metrics();
      res.writeHead(200, { "content-type": registry.contentType });
      res.end(body);
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", queues: workers.map((w) => w.name) }));
      return;
    }
    res.writeHead(404).end();
  });

  metricsServer.listen(config.metricsPort, () => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "worker service started",
        metricsPort: config.metricsPort,
        queues: workers.map((w) => w.name),
      }),
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", msg: "shutting down workers", signal }));
    await Promise.all(workers.map((w) => w.close()));
    metricsServer.close();
    await Promise.all([
      queues.dispatch.close(),
      queues.ttl.close(),
      queues.resolution.close(),
      queues.resume.close(),
    ]);
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal worker startup error", error);
  process.exit(1);
});
