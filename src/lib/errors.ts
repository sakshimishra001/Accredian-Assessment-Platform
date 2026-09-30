import type { z } from "zod";

export type FieldErrors = Record<string, string[] | undefined>;

/** Expected, user-facing failure. Anything else reaching an action is treated as a bug. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT",
    readonly fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, fieldErrors?: FieldErrors) {
    super(message, "VALIDATION", fieldErrors);
  }

  static fromZod(error: z.ZodError, message = "Please correct the highlighted fields.") {
    const fieldErrors: FieldErrors = {};
    const formErrors: string[] = [];
    for (const issue of error.issues) {
      const key = issue.path.map(String).join(".");
      if (!key) {
        formErrors.push(issue.message);
        continue;
      }
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return new ValidationError(formErrors[0] ?? message, fieldErrors);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You do not have permission to perform this action.") {
    super(message, "FORBIDDEN");
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "Not found.") {
    super(message, "NOT_FOUND");
  }
}

/** The request is valid but not allowed in the entity's current state. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, "CONFLICT");
  }
}
