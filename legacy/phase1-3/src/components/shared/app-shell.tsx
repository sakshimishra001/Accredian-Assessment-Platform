import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NAVIGATION } from "@/config/navigation";
import { siteConfig } from "@/config/site";
import { ROLE_LABEL } from "@/lib/auth/rbac";
import type { SessionUser } from "@/server/auth/session";
import { NavLinks } from "./nav-links";

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="flex h-14 items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{siteConfig.name}</span>
            <Badge variant="secondary">{ROLE_LABEL[user.role]}</Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right text-sm leading-tight sm:block">
              <div className="font-medium">{user.name}</div>
              <div className="text-xs text-muted-foreground">{user.email}</div>
            </div>
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="border-b p-3 md:w-56 md:border-r md:border-b-0">
          <NavLinks items={NAVIGATION[user.role]} />
        </aside>
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="text-xs font-medium text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
