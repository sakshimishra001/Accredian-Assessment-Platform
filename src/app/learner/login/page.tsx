import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Role, resolvePostLoginPath } from "@/lib/auth/rbac";
import { learnerLoginAction } from "@/server/auth/actions";
import { getCurrentUser } from "@/server/auth/current-user";
import { getLearnerLandingPath } from "@/server/services/learner-home";
import { LearnerLoginForm } from "./learner-login-form";

export const metadata: Metadata = { title: { absolute: "Learner sign in · Accredian" } };

/**
 * Learner sign-in (public; outside the learner area's gate). Already signed in: a learner goes where
 * signing in would take them (an active assessment, else the dashboard); staff go to their area.
 */
export default async function LearnerLoginPage({ searchParams }: PageProps<"/learner/login">) {
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? next : undefined;

  const user = await getCurrentUser();
  if (user) redirect(user.role === Role.LEARNER ? await getLearnerLandingPath(user) : resolvePostLoginPath(user.role, undefined));

  return <LearnerLoginForm action={learnerLoginAction} next={nextPath} />;
}
