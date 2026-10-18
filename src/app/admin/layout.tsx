import { AuthSessionProvider } from "@/components/auth/session-provider";
import { AppShell } from "@/components/proto/app-shell";
import { requireAreaUser } from "@/server/auth/area";

/** Server-side gate: a valid session with the ADMIN role, otherwise /login or /forbidden. */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await requireAreaUser("ADMIN");
  return (
    <AuthSessionProvider user={user}>
      <AppShell role="admin">{children}</AppShell>
    </AuthSessionProvider>
  );
}
