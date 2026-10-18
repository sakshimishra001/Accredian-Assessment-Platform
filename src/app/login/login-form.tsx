"use client";

import { startTransition, useActionState, useState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { ROLE_LABEL } from "@/components/proto/app-shell";
import { Field, SelectField } from "@/components/proto/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Role } from "@/prototype/types";
import { AccredianBrand as Brand } from "@/components/auth/accredian-brand";
import { loginAction } from "@/server/auth/actions";

/** Staff roles (see src/lib/auth/rbac.ts). Learners sign in at /learner/login, without choosing a role. */
const ROLES: Role[] = ["admin", "examiner", "reviewer"];

/**
 * Staff sign-in (administrator, examiner, proctor) with email + password. The role choice is only a
 * guide; the server decides the actual role from the account and redirects to that role's area.
 * Learners have their own sign-in page (/learner/login); a learner account can't sign in here.
 */
export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [state, staffAction, pending] = useActionState(loginAction, null);
  const [role, setRole] = useState<Role | "">("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function chooseRole(r: Role | "") {
    setRole(r);
    setErrors({});
    setPassword("");
  }

  /**
   * Quick client-side checks, then the server action (which validates again and authenticates).
   * Dispatched manually rather than via <form action> so a failed attempt doesn't reset the form.
   */
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!role) found.role = "Choose your role";
    if (!/^\S+@\S+\.\S+$/.test(email)) found.email = "Enter a valid email address";
    if (!password) found.password = "Password is required";
    setErrors(found);
    if (Object.keys(found).length) return;
    const data = new FormData(e.currentTarget);
    startTransition(() => staffAction(data));
  }

  const serverError = state && !state.ok ? state : null;
  const fieldError = (key: string) => errors[key] ?? serverError?.fieldErrors?.[key]?.[0];

  return (
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,36rem)]">
      {/* Brand panel (large screens) */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-primary p-12 lg:flex">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-white/5" aria-hidden />
        <div className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-white/5" aria-hidden />
        <Brand inverted />
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight text-white">Assessment Platform</h2>
          <p className="mt-3 text-base leading-relaxed text-white/80">Question papers, assessments, evaluation and results for Accredian programmes.</p>
        </div>
        <p className="relative text-xs text-white/70">© {new Date().getFullYear()} Accredian. Authorised users only.</p>
      </aside>

      {/* Sign-in */}
      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Brand />
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                <LockKeyhole className="size-4" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">Staff sign-in: administrators, examiners and proctors.</p>
              </div>
            </div>

            {notice ? (
              <p role="status" className="mt-5 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200 ring-inset">
                {notice}
              </p>
            ) : null}

            <form onSubmit={submit} className="mt-6 grid gap-4" noValidate>
              {next ? <input type="hidden" name="next" value={next} /> : null}
              <Field label="Role" htmlFor="role" error={errors.role}>
                <SelectField
                  id="role"
                  value={role}
                  onChange={(v) => chooseRole(v as Role | "")}
                  placeholder="Select your role"
                  invalid={!!errors.role}
                  options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                />
              </Field>
              <Field label="Email" htmlFor="email" error={fieldError("email")}>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="name@accredian.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!fieldError("email") || undefined}
                  className="h-10"
                />
              </Field>
              <Field label="Password" htmlFor="password" error={fieldError("password")}>
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

              <button
                type="button"
                className="justify-self-center text-sm text-primary hover:underline"
                onClick={() => setErrors({ email: "Ask an administrator to send you a password reset link." })}
              >
                Forgot password?
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Learner? <a href="/learner/login" className="text-primary hover:underline">Sign in here</a>.
          </p>

          <p className="mt-6 text-center text-xs text-muted-foreground lg:hidden">© {new Date().getFullYear()} Accredian. Authorised users only.</p>
        </div>
      </main>
    </div>
  );
}
