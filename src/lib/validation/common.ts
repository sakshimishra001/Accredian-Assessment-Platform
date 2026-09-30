import { z } from "zod";
import { parseIstInput } from "@/lib/datetime";

/** Marks: non-negative, at most 2 decimal places, sane upper bound. */
export const marksSchema = z.coerce
  .number({ error: "Enter a number" })
  .finite("Enter a number")
  .min(0, "Must be 0 or more")
  .max(1000, "Must be 1000 or less")
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, "Use at most 2 decimal places");

/** Empty string / missing → null; otherwise trimmed text. */
export const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v ?? null),
    z.string().trim().max(max, `Must be ${max} characters or fewer`).nullable(),
  );

/** Accepts a Date or an IST `datetime-local` string. */
export const istDateTime = z.preprocess((v) => {
  if (v instanceof Date) return v;
  if (typeof v === "string") return parseIstInput(v) ?? v;
  return v;
}, z.date({ error: "Enter a valid date and time" }));

/** Checkbox / boolean: "on", "true", true → true; "false", "", missing → false. */
export const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());
