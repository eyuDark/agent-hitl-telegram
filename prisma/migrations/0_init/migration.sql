-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "short_id" VARCHAR(12) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "agent_id" VARCHAR(64) NOT NULL,
    "thread_id" VARCHAR(128) NOT NULL,
    "tool_name" VARCHAR(128) NOT NULL,
    "tool_args_redacted" JSONB NOT NULL,
    "tool_args_hash" CHAR(64) NOT NULL,
    "risk" "risk_level" NOT NULL DEFAULT 'HIGH',
    "status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "telegram_chat_id" BIGINT NOT NULL,
    "telegram_message_id" BIGINT,
    "resolved_by_telegram_id" BIGINT,
    "resolved_by_username" VARCHAR(64),
    "resolution_reason" TEXT,
    "callback_url" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_short_id_key" ON "approval_requests"("short_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_idempotency_key_key" ON "approval_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "approval_requests_status_expires_at_idx" ON "approval_requests"("status", "expires_at");

-- CreateIndex
CREATE INDEX "approval_requests_thread_id_idx" ON "approval_requests"("thread_id");

-- CreateIndex
CREATE INDEX "approval_requests_agent_id_created_at_idx" ON "approval_requests"("agent_id", "created_at");

