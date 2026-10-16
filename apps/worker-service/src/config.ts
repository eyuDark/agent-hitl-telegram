import { loadEnv, parseIdList } from "@hitl/shared-types";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_IDS: z.string().optional(),
  HMAC_SECRET: z.string().min(8).default("insecure-dev-hmac-secret"),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  REMOTE_TTL_RECHECK_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
});

const env = loadEnv(envSchema);

export const config = {
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedTelegramIds: parseIdList(env.ALLOWED_TELEGRAM_IDS),
  hmacSecret: env.HMAC_SECRET,
  metricsPort: env.WORKER_METRICS_PORT,
  remoteTtlRecheckSeconds: env.REMOTE_TTL_RECHECK_SECONDS,
} as const;
