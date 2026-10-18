import { z } from "zod";
import { optionalText } from "./common";
import { emailSchema } from "./learner";

/** "2026-09-01" (date input) or a Date → that day at 00:00 IST; empty → null. */
const optionalIstDate = z.preprocess((v) => {
  if (v === "" || v === undefined || v === null) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00+05:30`);
  return v;
}, z.date({ error: "Enter a valid date" }).nullable());

const courseCode = z
  .string({ error: "Course code is required" })
  .trim()
  .min(2, "Course code must be at least 2 characters")
  .max(20, "Course code must be 20 characters or fewer")
  .regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers and hyphens only")
  .transform((v) => v.toUpperCase());

const courseName = z.string({ error: "Course name is required" }).trim().min(2, "Course name is required").max(120);

export const createCourseSchema = z.object({
  code: courseCode,
  name: courseName,
  description: optionalText(2000),
});

export const updateCourseSchema = createCourseSchema.partial();

const batchName = z.string({ error: "Batch name is required" }).trim().min(3, "Batch name must be at least 3 characters").max(120);

/** Optional short code; empty → null. Stored upper-case. */
const batchCode = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z
    .string()
    .trim()
    .max(30, "Batch code must be 30 characters or fewer")
    .regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers and hyphens only")
    .transform((v) => v.toUpperCase())
    .nullable()
    .optional(),
);

const batchFields = {
  name: batchName,
  code: batchCode,
  startDate: optionalIstDate.optional(),
  endDate: optionalIstDate.optional(),
};

const datesInOrder = (v: { startDate?: Date | null; endDate?: Date | null }) => !(v.startDate && v.endDate && v.endDate < v.startDate);
const datesMessage = { message: "End date must be on or after the start date", path: ["endDate"] };

export const createBatchSchema = z
  .object({ ...batchFields, courseId: z.string({ error: "Choose a course" }).min(1, "Choose a course") })
  .refine(datesInOrder, datesMessage);

/** A batch's course is fixed once created (see updateBatch). */
export const updateBatchSchema = z
  .object({ ...batchFields, name: batchName.optional(), courseId: z.string().optional() })
  .refine(datesInOrder, datesMessage);

/** Add a learner: name + email + batch, all required. */
export const addLearnerSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(2, "Name must be at least 2 characters").max(120),
  email: emailSchema,
  batchId: z.string({ error: "Choose a batch" }).min(1, "Choose a batch"),
});

export const activeFlagSchema = z.boolean({ error: "Choose active or inactive" });
