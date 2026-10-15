import { loadEnv } from "@hitl/shared-types";
import { z } from "zod";

const envSchema = z.object({
  GATEWAY_URL: z.string().url().default("http://localhost:3000"),
  GATEWAY_API_KEY: z.string().optional(),
  REDIS_URL: z.string().optional(),
  HITL_AGENT_ID: z.string().min(1).max(64).default("mcp-client"),
  HITL_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
});

const env = loadEnv(envSchema);

export const config = {
  gatewayUrl: env.GATEWAY_URL,
  apiKey: env.GATEWAY_API_KEY,
  redisUrl: env.REDIS_URL,
  agentId: env.HITL_AGENT_ID,
  defaultTtlSeconds: env.HITL_DEFAULT_TTL_SECONDS,
} as const;

export function log(level: "info" | "error", message: string, extra: object = {}): void {
  process.stderr.write(`${JSON.stringify({ level, msg: message, ...extra })}\n`);
}
