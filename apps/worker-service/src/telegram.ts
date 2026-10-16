import { Bot, InlineKeyboard } from "grammy";
import { encodeChoiceCallback } from "@hitl/shared-types";
import { config } from "./config.js";

export const bot = new Bot(config.telegramBotToken);

export function decisionKeyboard(shortId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `act:ap:${shortId}`)
    .text("❌ Deny", `act:dn:${shortId}`);
}

export function choiceKeyboard(options: { label: string }[], shortId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  options.forEach((option, index) => {
    keyboard.text(option.label, encodeChoiceCallback(shortId, index));
  });
  return keyboard;
}
