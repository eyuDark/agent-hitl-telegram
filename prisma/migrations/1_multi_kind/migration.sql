-- CreateEnum
CREATE TYPE "approval_kind" AS ENUM ('DECISION', 'CHOICE', 'QUESTION');

-- AlterEnum
ALTER TYPE "approval_status" ADD VALUE 'ANSWERED';

-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "answer_json" JSONB,
ADD COLUMN     "kind" "approval_kind" NOT NULL DEFAULT 'DECISION',
ADD COLUMN     "options_json" JSONB,
ADD COLUMN     "prompt" TEXT;

