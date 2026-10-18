import { randomInt } from "node:crypto";

/** No 0/O, 1/I/L: codes are read aloud, printed and typed by hand. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const EXAM_CODE_LENGTH = 6;

/** A random exam password such as "X7K92P" (≈ 31^6 ≈ 887 million combinations). */
export function generateExamCode(length = EXAM_CODE_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** A learner's own password is longer than a one-off exam code (≈ 31^10 ≈ 8 × 10^14 combinations). */
export const LEARNER_PASSWORD_LENGTH = 10;
