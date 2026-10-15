import { customAlphabet } from "nanoid";

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generate = customAlphabet(base62, 10);

export function generateShortId(): string {
  return generate();
}
