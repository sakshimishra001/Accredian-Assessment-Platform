import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/proto/app-shell";
import { peekPasswordToken } from "@/server/services/staff";
import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = { title: "Set your password", referrer: "no-referrer" };

/** Public page behind a one-time link: a staff member sets their own password. */
export default async function SetPasswordPage({ searchParams }: PageProps<"/set-password">) {
  const { token } = await searchParams;
  const value = typeof token === "string" ? token : "";
  const link = await peekPasswordToken(value);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 inline-flex">
          <Logo />
        </Link>
        {link ? (
          <>
            <h1 className="text-xl font-semibold tracking-tight">{link.purpose === "INVITE" ? "Welcome — set your password" : "Choose a new password"}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              For {link.name} ({link.email}). This link works once.
            </p>
            <SetPasswordForm token={value} />
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold tracking-tight">This link can’t be used</h1>
            <p className="mt-2 text-sm text-muted-foreground">It is invalid, has expired or was already used. Ask an administrator to send you a new one.</p>
            <Link href="/login" className="mt-6 inline-block text-sm text-primary hover:underline">
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
