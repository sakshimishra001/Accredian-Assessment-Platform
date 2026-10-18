import { z } from "zod";
import { ProctoringEventType } from "@/generated/prisma/enums";

/**
 * What a browser may report about a proctoring event. Everything that matters — the time, the
 * violation number, the severity and any action — is decided by the server, so those fields are
 * refused rather than ignored. Metadata is a handful of small plain values (never images, audio,
 * video or biometric data).
 */
export const proctoringEventSchema = z
  .object({
    eventType: z.enum(ProctoringEventType, { error: "Unknown event type" }),
    /** Made up by the browser per incident, so a repeated report of the same incident counts once. */
    incidentId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Invalid incident").optional(),
    durationMs: z.number().int().min(0).max(24 * 3600_000).optional(),
    metadata: z
      .record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/, "Invalid metadata key"), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
      .refine((m) => Object.keys(m).length <= 10, "At most 10 metadata values")
      .optional(),
  })
  .strict();

export type ProctoringEventInput = z.input<typeof proctoringEventSchema>;
