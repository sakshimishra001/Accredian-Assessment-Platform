import { AppShell } from "@/components/shared/app-shell";
import { requireRole } from "@/server/auth/guards";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await requireRole("ADMIN");
  return <AppShell user={user}>{children}</AppShell>;
}
