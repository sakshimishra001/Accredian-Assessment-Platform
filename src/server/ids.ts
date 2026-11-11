import "server-only";
import { randomBytes } from "node:crypto";

/*
 * Row ids generated in the application, for bulk inserts (createMany) whose rows reference each
 * other — a question's options, a group's sub-questions — so every id is known before anything is
 * written. Same shape as Prisma's @default(cuid()) ids: "c" + lower-case base-36 (25 characters):
 * a millisecond timestamp, a per-process counter and 64 random bits, so ids are unique across
 * concurrent server instances.
 */

let counter = 0;

export function newId(): string {
  counter = (counter + 1) % 1_679_616; // 36^4
  const time = Date.now().toString(36).padStart(8, "0").slice(-8);
  const count = counter.toString(36).padStart(4, "0");
  const random = BigInt(`0x${randomBytes(8).toString("hex")}`).toString(36).padStart(12, "0").slice(-12);
  return `c${time}${count}${random}`;
}
