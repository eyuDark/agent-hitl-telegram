import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";

export const bot = new Bot(config.telegramBotToken);

export function decisionKeyboard(shortId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `act:ap:${shortId}`)
    .text("❌ Deny", `act:dn:${shortId}`);
}

export function selectionKeyboard(options: { label: string }[]): {
  keyboard: { text: string }[][];
  resize_keyboard: true;
  one_time_keyboard: true;
  input_field_placeholder: string;
} {
  return {
    keyboard: options.map((option) => [{ text: option.label }]),
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: "Select an option…",
  };
}

export function questionReplyMarkup(): {
  force_reply: true;
  selective: true;
  input_field_placeholder: string;
} {
  return {
    force_reply: true,
    selective: true,
    input_field_placeholder: "Type your answer…",
  };
}

export function removeKeyboard(): { remove_keyboard: true; selective: true } {
  return { remove_keyboard: true, selective: true };
}
