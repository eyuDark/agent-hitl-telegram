import { loadEnv, parseIdList } from "@hitl/shared-types";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8),
  ALLOWED_TELEGRAM_IDS: z.string().min(1),
  DEFAULT_TELEGRAM_CHAT_ID: z.string().min(1),
  GATEWAY_API_KEY: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  HMAC_SECRET: z.string().min(8).default("insecure-dev-hmac-secret"),
  REQUEST_TTL_SECONDS_DEFAULT: z.coerce.number().int().min(30).max(86_400).default(900),
});

const env = loadEnv(envSchema);

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  allowedTelegramIds: parseIdList(env.ALLOWED_TELEGRAM_IDS),
  defaultTelegramChatId: env.DEFAULT_TELEGRAM_CHAT_ID,
  apiKey: env.GATEWAY_API_KEY,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  hmacSecret: env.HMAC_SECRET,
  defaultTtlSeconds: env.REQUEST_TTL_SECONDS_DEFAULT,
} as const;
