import { AuthSessionProvider } from "@/components/auth/session-provider";
import { AppShell } from "@/components/proto/app-shell";
import { requireAreaUser } from "@/server/auth/area";

/** Server-side gate: a valid session with the EXAMINER role, otherwise /login or /forbidden. */
export default async function ExaminerLayout({ children }: LayoutProps<"/examiner">) {
  const user = await requireAreaUser("EXAMINER");
  return (
    <AuthSessionProvider user={user}>
      <AppShell role="examiner">{children}</AppShell>
    </AuthSessionProvider>
  );
}
