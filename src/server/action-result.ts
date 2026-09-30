import "server-only";
import { DomainError, type FieldErrors } from "@/lib/errors";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

/** Initial state for useActionState. */
export type FormState = ActionResult | null;

/**
 * Run a mutation and translate expected (domain) failures into a result the form can show.
 * Unexpected errors are logged and replaced with a generic message.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    console.error("[action] unexpected error", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

/** FormData → plain object. Repeated keys keep the last value (used for checkbox + hidden fallback). */
export function formToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION")) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
