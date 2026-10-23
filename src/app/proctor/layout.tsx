import type { Metadata } from "next";
import { AuthSessionProvider } from "@/components/auth/session-provider";
import { AppShell } from "@/components/proto/app-shell";
import { requireAreaUser } from "@/server/auth/area";

export const metadata: Metadata = { title: { default: "Proctoring", template: "%s · Proctoring" } };

/**
 * Proctor portal. Server-side gate: a valid session as a proctor (REVIEWER) or an administrator,
 * otherwise /login or /forbidden. Which assessments each may see is decided per page by the
 * proctor services (assertCanProctor): proctors only see the assessments assigned to them.
 */
export default async function ProctorLayout({ children }: LayoutProps<"/proctor">) {
  const user = await requireAreaUser("REVIEWER", "ADMIN");
  return (
    <AuthSessionProvider user={user}>
      <AppShell role="reviewer">{children}</AppShell>
    </AuthSessionProvider>
  );
}
