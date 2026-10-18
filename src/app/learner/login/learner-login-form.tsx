"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { AccredianBrand } from "@/components/auth/accredian-brand";
import { Field } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/action-result";

/**
 * Learner sign-in: email + the learner's password, nothing else — no role to choose (staff sign in
 * at /login). The server authenticates the learner and decides where they go next; that page is
 * opened with a full page load, so its own security headers apply (the exam page's camera and
 * face-detection permissions don't carry over an in-app navigation). The action is a prop so the
 * page passes the server action (and tests can render the form on its own).
 */
type LoginState = ActionResult<string> | null;

export function LearnerLoginForm({ action, next, notice }: { action: (prev: LoginState, data: FormData) => Promise<LoginState>; next?: string; notice?: string }) {
  const [state, dispatch, actionPending] = useActionState<LoginState, FormData>(action, null);
  const destination = state?.ok && typeof state.data === "string" && state.data.startsWith("/") && !state.data.startsWith("//") ? state.data : null;
  const pending = actionPending || !!destination;
  useEffect(() => {
    if (destination) window.location.assign(destination);
  }, [destination]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** Quick client-side checks, then the server action (which validates again and authenticates). */
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) found.email = "Enter a valid email address";
    if (!password) found.password = "Password is required";
    setErrors(found);
    if (Object.keys(found).length) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  }

  const serverError = state && !state.ok ? state : null;
  const fieldError = (key: string) => errors[key] ?? serverError?.fieldErrors?.[key]?.[0];

  return (
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,36rem)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-primary p-12 lg:flex">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-white/5" aria-hidden />
        <div className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-white/5" aria-hidden />
        <AccredianBrand inverted subtitle={null} />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight text-white">Your assessments</h2>
          <p className="mt-3 text-base leading-relaxed text-white/80">Sign in to take your assessments and see your results.</p>
        </div>
        <p className="relative text-xs text-white/70">© {new Date().getFullYear()} Accredian.</p>
      </aside>

      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <AccredianBrand subtitle={null} />
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                <LockKeyhole className="size-4" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Learner sign in</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">Use your email and your learner password.</p>
              </div>
            </div>

            {notice ? (
              <p role="status" className="mt-5 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset">
                {notice}
              </p>
            ) : null}

            <form onSubmit={submit} className="mt-6 grid gap-4" noValidate>
              {next ? <input type="hidden" name="next" value={next} /> : null}
              <Field label="Email" htmlFor="email" error={fieldError("email")}>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!fieldError("email") || undefined}
                  className="h-10"
                />
              </Field>
              <Field label="Password" htmlFor="password" error={fieldError("password")} hint="The learner password your administrator gave you. It works for all your assessments.">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fieldError("password") || !!serverError || undefined}
                  className="h-10"
                />
              </Field>

              {serverError && !serverError.fieldErrors ? (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {serverError.error}
                </p>
              ) : null}

              <Button type="submit" size="lg" className="mt-1 h-10 w-full" disabled={pending}>
                {pending ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden /> Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>

              <button type="button" className="justify-self-center text-sm text-primary hover:underline" onClick={() => setErrors({ email: "Contact your administrator for a new learner password." })}>
                Forgot your password?
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Staff? <a href="/login" className="text-primary hover:underline">Sign in here</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
