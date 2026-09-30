import { AppShell } from "@/components/shared/app-shell";
import { requireRole } from "@/server/auth/guards";

export default async function ExaminerLayout({ children }: LayoutProps<"/examiner">) {
  const user = await requireRole("EXAMINER");
  return <AppShell user={user}>{children}</AppShell>;
}
