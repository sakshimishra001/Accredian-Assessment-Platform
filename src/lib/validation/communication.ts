import { z } from "zod";
import { unknownVariables } from "@/lib/communication/templates";
import { optionalText } from "./common";

const noUnknownVariables = (text: string, ctx: z.RefinementCtx) => {
  const unknown = unknownVariables(text);
  if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((v) => `{{${v}}}`).join(", ")}` });
};

export const templateSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(3, "Name must be at least 3 characters").max(120),
  type: z.enum(["ASSESSMENT", "REMINDER", "ASSESSMENT_UPDATE", "RESULTS"], { error: "Choose a type" }),
  trigger: z.string().trim().max(200).default(""),
  subject: z.string({ error: "Subject is required" }).trim().min(1, "Subject is required").max(200).superRefine(noUnknownVariables),
  body: z.string({ error: "Body is required" }).trim().min(1, "Body is required").max(20_000).superRefine(noUnknownVariables),
  status: z.enum(["ACTIVE", "DRAFT", "DISABLED"]).default("DRAFT"),
  fromName: z.string({ error: "Sender name is required" }).trim().min(1, "Sender name is required").max(120),
  fromEmail: z.string({ error: "Sender email is required" }).trim().toLowerCase().pipe(z.email("Enter a valid sender email")),
  replyTo: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : (v ?? null)), z.string().trim().toLowerCase().pipe(z.email("Enter a valid reply-to email")).nullable()),
});
export type TemplateInput = z.output<typeof templateSchema>;
/** Partial update: create-time defaults are removed so omitted fields stay unchanged. */
export const templateUpdateSchema = templateSchema
  .extend({ trigger: templateSchema.shape.trigger.removeDefault(), status: templateSchema.shape.status.removeDefault() })
  .partial();

const eventSettingSchema = z.object({
  enabled: z.boolean().default(false),
  templateId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().min(1).nullable()),
  overrideSubject: optionalText(200).pipe(z.string().nullable().superRefine((v, ctx) => {
    if (v) noUnknownVariables(v, ctx);
  })),
  overrideBody: optionalText(20_000).pipe(z.string().nullable().superRefine((v, ctx) => {
    if (v) noUnknownVariables(v, ctx);
  })),
});

/** The Communication step of the Assessment Builder: one entry per communication. */
export const assessmentCommunicationSchema = z.object({
  ASSIGNMENT: eventSettingSchema,
  REMINDER: eventSettingSchema.extend({
    reminderTiming: z.enum(["H24", "H12", "H2", "CUSTOM"]).default("H24"),
    /** IST datetime-local, only for CUSTOM. */
    reminderAt: z.preprocess((v) => (v === "" ? null : v), z.string().nullable().default(null)),
  }),
  STARTING_SOON: eventSettingSchema,
  RESCHEDULED: eventSettingSchema,
  CANCELLED: eventSettingSchema,
  RESULT_PUBLISHED: eventSettingSchema,
});
export type AssessmentCommunicationInput = z.output<typeof assessmentCommunicationSchema>;
