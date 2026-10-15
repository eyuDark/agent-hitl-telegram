import { existsSync } from "node:fs";
import { z } from "zod";

export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // ignore malformed .env; explicit process env still wins
  }
}

export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  loadDotEnv();
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export function parseIdList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id));
}
