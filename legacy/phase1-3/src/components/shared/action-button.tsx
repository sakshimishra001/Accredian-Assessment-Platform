"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Result = { ok: true; message?: string } | { ok: false; error: string } | null;

/**
 * A button that runs a server action, with an optional inline "are you sure" step
 * (no browser confirm dialog) and inline error display.
 */
export function ActionButton({
  action,
  children,
  confirm,
  variant = "outline",
  size = "sm",
  disabled,
  title,
}: {
  action: (prev: Result, formData: FormData) => Promise<Result>;
  children: ReactNode;
  confirm?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "xs" | "icon-sm";
  disabled?: boolean;
  title?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      {confirm && confirming ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{confirm}</span>
          <Button type="submit" size={size} variant={variant === "outline" ? "default" : variant} disabled={pending}>
            {pending ? "Working…" : "Confirm"}
          </Button>
          <Button type="button" size={size} variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
            Cancel
          </Button>
        </span>
      ) : confirm ? (
        <Button type="button" size={size} variant={variant} disabled={disabled} title={title} onClick={() => setConfirming(true)}>
          {children}
        </Button>
      ) : (
        <Button type="submit" size={size} variant={variant} disabled={disabled || pending} title={title}>
          {children}
        </Button>
      )}
      {state && !state.ok ? <span className="max-w-xs text-xs text-destructive">{state.error}</span> : null}
    </form>
  );
}
