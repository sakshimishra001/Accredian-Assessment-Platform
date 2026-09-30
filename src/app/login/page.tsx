"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Logo, ROLE_LABEL } from "@/components/proto/app-shell";
import { Field, SelectField } from "@/components/proto/controls";
import { PrototypeNote } from "@/components/proto/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEMO_USERS, useProtoActions } from "@/prototype/store";
import type { Role } from "@/prototype/types";

const ROLES: Role[] = ["admin", "examiner", "reviewer", "learner"];
const HOME: Record<Role, string> = { admin: "/admin", examiner: "/examiner", reviewer: "/reviewer", learner: "/learner" };
const CAPTCHA_CODES = ["7K4PQ2", "M9X3TR", "H2B8WZ", "Q5N7LD"];

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useProtoActions();
  const [role, setRole] = useState<Role | "">("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [captchaIndex, setCaptchaIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function chooseRole(r: Role | "") {
    setRole(r);
    setErrors({});
    setEmail(r ? DEMO_USERS[r].email : "");
    setPassword("");
    setCaptcha("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!role) return;
    const next: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) next.email = "Enter a valid email address";
    if (password.length < 4) next.password = "Enter your password (any 4+ characters in prototype mode)";
    if (role === "learner" && captcha.trim().toUpperCase() !== CAPTCHA_CODES[captchaIndex]) next.captcha = "The characters don’t match. Try again.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSubmitting(true);
    // Simulated sign-in latency.
    setTimeout(() => {
      const demo = DEMO_USERS[role];
      signIn({ ...demo, email: email.toLowerCase() === demo.email ? demo.email : email.toLowerCase() });
      router.push(HOME[role]);
    }, 600);
  }

  return (
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[1fr_minmax(0,32rem)]">
      <div className="hidden flex-col justify-between border-r bg-sidebar p-10 lg:flex">
        <Link href="/">
          <Logo />
        </Link>
        <div className="max-w-md">
          <p className="text-2xl font-semibold tracking-tight">Create. Assess. Evaluate.</p>
          <p className="mt-3 text-muted-foreground">
            Manage question papers, schedule assessments for your batches and track evaluation — from one place.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">Prototype build · all data is simulated</p>
      </div>

      <div className="flex flex-col justify-center px-4 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="mb-8 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
            <ArrowLeft className="size-4" /> Back
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Welcome to Assessment Platform</h1>
          <p className="mt-1 text-sm text-muted-foreground">Select how you want to continue</p>

          <form onSubmit={submit} className="mt-6 grid gap-4" noValidate>
            <Field label="Continue as" htmlFor="role">
              <SelectField
                id="role"
                value={role}
                onChange={(v) => chooseRole(v as Role | "")}
                placeholder="Select a role…"
                options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              />
            </Field>

            {role ? (
              <>
                <Field label="Email" htmlFor="email" error={errors.email}>
                  <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email || undefined} />
                </Field>
                <Field label="Password" htmlFor="password" error={errors.password}>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Any password works in prototype mode"
                    aria-invalid={!!errors.password || undefined}
                  />
                </Field>
                {role === "learner" ? (
                  <Field label="Verification" htmlFor="captcha" error={errors.captcha} hint="Captcha placeholder — type the characters shown.">
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-8 w-28 shrink-0 items-center justify-center rounded-md border bg-muted font-mono text-sm tracking-[0.3em] text-foreground/80 italic select-none"
                        aria-label={`Captcha: ${CAPTCHA_CODES[captchaIndex].split("").join(" ")}`}
                      >
                        {CAPTCHA_CODES[captchaIndex]}
                      </span>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label="New captcha" onClick={() => setCaptchaIndex((i) => (i + 1) % CAPTCHA_CODES.length)}>
                        <RefreshCw />
                      </Button>
                      <Input id="captcha" value={captcha} onChange={(e) => setCaptcha(e.target.value)} aria-invalid={!!errors.captcha || undefined} autoComplete="off" />
                    </div>
                  </Field>
                ) : null}
                <Button type="submit" size="lg" className="h-9" disabled={submitting}>
                  {submitting ? "Signing in…" : "Sign in"}
                </Button>
                <button
                  type="button"
                  className="justify-self-start text-xs text-primary hover:underline"
                  onClick={() => setErrors({ email: "Password reset is not available in prototype mode." })}
                >
                  Forgot password?
                </button>
              </>
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">Choose a role to see its sign-in form.</p>
            )}
          </form>

          <div className="mt-8 grid gap-2">
            <PrototypeNote>Prototype mode — no real authentication</PrototypeNote>
            <p className="text-xs text-muted-foreground">
              Demo accounts: admin@example.com, examiner@example.com, doctor@example.com, learner@example.com. Any password of 4+ characters works.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
