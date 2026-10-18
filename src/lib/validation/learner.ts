import { z } from "zod";
import { UserStatus } from "@/generated/prisma/enums";
import { istDateTime } from "./common";

/** Trimmed, lower-cased email: the unique login identifier for every user, including learners. */
export const emailSchema = z
  .string({ error: "Email is required" })
  .trim()
  .min(1, "Email is required")
  .max(254)
  .pipe(z.email("Enter a valid email address"))
  .transform((v) => v.toLowerCase());

/** Learner sign-in: email + the learner's password (kept as typed; never logged or stored). */
export const learnerLoginSchema = z.object({
  email: emailSchema,
  password: z.string({ error: "Password is required" }).min(1, "Password is required").max(128, "Password is too long"),
  next: z.string().max(2048).optional(),
});

export const createLearnerSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(2, "Name must be at least 2 characters").max(120),
  email: emailSchema,
  batchId: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

export const userStatusSchema = z.enum(UserStatus, { error: "Choose a status" });

/** Optional override of a credential's validity window. Defaults come from the assessment schedule. */
export const credentialWindowSchema = z
  .object({
    validFrom: istDateTime.optional(),
    validUntil: istDateTime.optional(),
  })
  .default({});

export const examLoginSchema = z.object({
  email: emailSchema,
  // Normalised so "x7k-92p " and "X7K92P" are the same code.
  code: z
    .string({ error: "Exam password is required" })
    .transform((v) => v.replace(/[\s-]/g, "").toUpperCase())
    .pipe(z.string().min(1, "Exam password is required").max(32, "Exam password is too long")),
  next: z.string().max(2048).optional(),
});

export type CreateLearnerInput = z.infer<typeof createLearnerSchema>;
