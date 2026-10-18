import type { Metadata } from "next";
import { AuthSessionProvider } from "@/components/auth/session-provider";
import { requireAreaUser } from "@/server/auth/area";
import { LearnerChrome } from "./learner-chrome";

/** Learner pages carry the Accredian name in the browser tab. */
export const metadata: Metadata = { title: { default: "Accredian", template: "%s · Accredian" } };

/** Server-side gate: a valid session with the LEARNER role, otherwise /learner/login or /forbidden. */
export default async function LearnerLayout({ children }: LayoutProps<"/learner">) {
  const user = await requireAreaUser("LEARNER");
  return (
    <AuthSessionProvider user={user}>
      <LearnerChrome>{children}</LearnerChrome>
    </AuthSessionProvider>
  );
}
