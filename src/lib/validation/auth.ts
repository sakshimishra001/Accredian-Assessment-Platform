import { z } from "zod";

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .max(254)
    .pipe(z.email("Enter a valid email address"))
    .transform((v) => v.toLowerCase()),
  password: z.string().min(1, "Password is required").max(200),
  next: z.string().max(2048).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
