import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolvePostLoginPath } from "@/lib/auth/rbac";
import { getCurrentUser } from "@/server/auth/current-user";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, password } = await searchParams;
  const nextPath = typeof next === "string" ? next : undefined;

  // Already signed in (valid session): go straight to the right area.
  const user = await getCurrentUser();
  if (user) redirect(resolvePostLoginPath(user.role, nextPath));

  return <LoginForm next={nextPath} notice={password === "set" ? "Your password is set. Sign in with it now." : undefined} />;
}
