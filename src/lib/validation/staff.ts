import { z } from "zod";

/** Roles an administrator can give a staff account. Learners are managed through batches. */
export const STAFF_ROLES = ["ADMIN", "EXAMINER", "REVIEWER"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const staffAccountSchema = z.object({
  name: z.string().trim().min(2, "Enter the person’s full name").max(120, "Must be 120 characters or fewer"),
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .max(254)
    .pipe(z.email("Enter a valid email address"))
    .transform((v) => v.toLowerCase()),
  role: z.enum(STAFF_ROLES, { error: "Choose a role" }),
});

/** bcrypt only reads the first 72 bytes; longer passwords are refused rather than silently cut. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX_BYTES = 72;

export const setPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: z
      .string()
      .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
      .refine((v) => new TextEncoder().encode(v).length <= PASSWORD_MAX_BYTES, `Use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} letters)`)
      .refine((v) => v.trim().length === v.length, "Don’t start or end with a space"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The passwords don’t match" });
