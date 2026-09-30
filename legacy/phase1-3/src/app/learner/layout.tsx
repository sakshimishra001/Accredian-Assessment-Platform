import { AppShell } from "@/components/shared/app-shell";
import { requireRole } from "@/server/auth/guards";

export default async function LearnerLayout({ children }: LayoutProps<"/learner">) {
  const user = await requireRole("LEARNER");
  return <AppShell user={user}>{children}</AppShell>;
}
