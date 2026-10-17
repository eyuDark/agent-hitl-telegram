-- Partial unique index: Telegram re-delivery of the same operator steering
-- message (webhook swap/retry) must not create duplicate ledger rows.
CREATE UNIQUE INDEX "approval_requests_chat_msg_unique"
  ON "approval_requests"("telegram_chat_id", "telegram_message_id")
  WHERE "tool_name" = 'operator_message';
