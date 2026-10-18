"use client";

import { useActionState } from "react";
import { Field } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PASSWORD_MIN } from "@/lib/validation/staff";
import { setPasswordAction } from "@/server/actions/staff";

export function SetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(setPasswordAction, null);
  const error = state && !state.ok ? state : null;
  const fieldError = (key: string) => error?.fieldErrors?.[key]?.[0];

  return (
    <form action={action} className="mt-6 grid gap-4">
      <input type="hidden" name="token" value={token} />
      <Field label="New password" htmlFor="password" error={fieldError("password")} hint={`At least ${PASSWORD_MIN} characters. A passphrase of a few words works well.`}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} aria-invalid={!!fieldError("password") || undefined} />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={fieldError("confirm")}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required aria-invalid={!!fieldError("confirm") || undefined} />
      </Field>
      {error && !error.fieldErrors ? (
        <p role="alert" className="text-sm text-destructive">
          {error.error}
        </p>
      ) : null}
      <Button type="submit" size="lg" className="h-9" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
