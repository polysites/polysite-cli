import { randomBytes, randomInt } from "node:crypto";

/** A long random secret for signing and encryption keys: 32 random bytes, URL-safe, no padding (43 characters). */
export const randomSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "-_.";

/** A password a person can type: 20 characters from an unambiguous alphabet, with at least one of each kind. */
export function generatePassword(length = 20) {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

const PLACEHOLDER = /(changeme|change-me|replace[-_ ]?me|example|your[-_ ]?secret|password|secret123|xxxx|todo|generate-a-long)/i;

/** Returns why a secret is weak, or null when it is acceptable. Never includes the value in the reason. */
export function weakSecretReason(value, { minLength = 32 } = {}) {
  if (!value) return "is empty";
  if (PLACEHOLDER.test(value)) return "looks like a placeholder";
  if (value.length < minLength) return `is shorter than ${minLength} characters`;
  if (new Set(value).size < 10) return "has too little variety (repeated characters)";
  return null;
}
