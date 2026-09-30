"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string[] | string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const message = Array.isArray(error) ? error[0] : error;
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {message ? (
        <p className="text-xs text-destructive" role="alert">
          {message}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function FormMessage({ state }: { state: { ok: boolean; error?: string; message?: string } | null }) {
  if (!state) return null;
  if (!state.ok && state.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  if (state.ok && state.message) {
    return (
      <Alert>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

/**
 * Like useActionState, but submits via onSubmit so React does not reset the form's fields
 * afterwards — on a validation error the user keeps what they typed.
 */
export function useFormSubmit<S>(action: (prev: Awaited<S>, formData: FormData) => S | Promise<S>, initialState: Awaited<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, initialState);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(() => dispatch(formData));
  };
  return [state, onSubmit, pending] as const;
}

export function SubmitButton({ children, pending, pendingText }: { children: ReactNode; pending: boolean; pendingText?: string }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? (pendingText ?? "Saving…") : children}
    </Button>
  );
}
