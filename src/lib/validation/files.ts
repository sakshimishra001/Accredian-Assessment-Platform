import { z } from "zod";
import { LEARNER_EXTENSIONS, MAX_ANSWER_FILES, MAX_ANSWER_MB, RETIRED_UPLOAD_EXTENSIONS } from "@/lib/files/types";
import { optionalText } from "./common";

/**
 * How a learner answers a written question. TEXT needs no file settings; FILE and TEXT_FILE need
 * at least one accepted type. Objective questions always use TEXT (the setting is ignored).
 */
export const responseConfigSchema = z
  .object({
    type: z.enum(["TEXT", "FILE", "TEXT_FILE"], { error: "Choose how learners answer" }).default("TEXT"),
    allowedFileTypes: z
      // Formats retired for security (see RETIRED_UPLOAD_EXTENSIONS) are dropped from older settings.
      .preprocess(
        (v) => (Array.isArray(v) ? v.filter((e) => typeof e !== "string" || !RETIRED_UPLOAD_EXTENSIONS.includes(e.trim().toLowerCase())) : v),
        z.array(z.string().trim().toLowerCase()).max(LEARNER_EXTENSIONS.length),
      )
      .default([])
      .refine((list) => list.every((e) => LEARNER_EXTENSIONS.includes(e)), "Unsupported file type"),
    maxFileSizeMb: z.coerce.number({ error: "Enter a size in MB" }).int("Whole MB only").min(1, "At least 1 MB").max(MAX_ANSWER_MB, `At most ${MAX_ANSWER_MB} MB`).default(20),
    maxFiles: z.coerce.number({ error: "Enter a number" }).int().min(1, "At least 1 file").max(MAX_ANSWER_FILES, `At most ${MAX_ANSWER_FILES} files`).default(1),
    fileRequired: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.type !== "TEXT" && v.allowedFileTypes.length === 0) ctx.addIssue({ code: "custom", path: ["allowedFileTypes"], message: "Choose at least one file type learners may upload" });
  })
  .transform((v) => (v.type === "TEXT" ? { ...v, allowedFileTypes: [], fileRequired: false } : { ...v, allowedFileTypes: [...new Set(v.allowedFileTypes)] }));

export type ResponseConfigInput = z.output<typeof responseConfigSchema>;

export const materialDescriptionSchema = optionalText(500);
