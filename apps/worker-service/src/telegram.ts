import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";

export const bot = new Bot(config.telegramBotToken);

export function approvalKeyboard(shortId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `act:ap:${shortId}`)
    .text("❌ Deny", `act:dn:${shortId}`);
}
