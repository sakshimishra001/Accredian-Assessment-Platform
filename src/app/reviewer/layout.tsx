import { AuthSessionProvider } from "@/components/auth/session-provider";
import { AppShell } from "@/components/proto/app-shell";
import { requireAreaUser } from "@/server/auth/area";

/** Server-side gate: a valid session with the REVIEWER role, otherwise /login or /forbidden. */
export default async function ReviewerLayout({ children }: LayoutProps<"/reviewer">) {
  const user = await requireAreaUser("REVIEWER");
  return (
    <AuthSessionProvider user={user}>
      <AppShell role="reviewer">{children}</AppShell>
    </AuthSessionProvider>
  );
}
