"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import {
  MonitorCheck,
  ClipboardList,
  FileUp,
  GraduationCap,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  UserCog,
  UserRound,
  Users,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/prototype/lib/format";
import { useAuthUser } from "@/components/auth/session-provider";
import { logoutAction } from "@/server/auth/actions";
import type { Role } from "@/prototype/types";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const NAV: Record<Role, NavItem[]> = {
  admin: [
    { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
    { label: "Assessments", href: "/admin/assessments", icon: ClipboardList },
    { label: "Import Questions", href: "/admin/import-questions", icon: FileUp },
    { label: "Batches & Learners", href: "/admin/batches", icon: Users },
    { label: "Examiners", href: "/admin/examiners", icon: UserCog },
    { label: "Proctoring", href: "/admin/proctoring", icon: ShieldCheck },
    { label: "Communication", href: "/admin/communication", icon: Mail },
    { label: "Results & Reports", href: "/admin/results", icon: BarChart3 },
    { label: "Users & Roles", href: "/admin/users", icon: UserRound },
    { label: "Settings", href: "/admin/settings", icon: Settings },
  ],
  examiner: [
    { label: "Dashboard", href: "/examiner", icon: LayoutDashboard },
    { label: "Evaluations", href: "/examiner/evaluations", icon: SquareCheckBig },
  ],
  reviewer: [{ label: "Assigned Assessments", href: "/proctor", icon: MonitorCheck }],
  learner: [
    { label: "Dashboard", href: "/learner", icon: LayoutDashboard },
    { label: "My Assessments", href: "/learner/assessments", icon: GraduationCap },
    { label: "My Results", href: "/learner/results", icon: BarChart3 },
  ],
};

const HOME: Record<Role, string> = { admin: "/admin", examiner: "/examiner", reviewer: "/proctor", learner: "/learner" };
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", examiner: "Examiner", reviewer: "Proctor", learner: "Learner" };
const HELP: Record<Role, string> = { admin: "/admin/help", examiner: "/examiner/help", reviewer: "/proctor/help", learner: "/learner/help" };

function isActive(pathname: string, href: string, home: string) {
  return href === home ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** The Accredian mark (learner exam screens, sign-in helpers); collapsed shows the mark only. */
export function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground" aria-hidden>
        A
      </span>
      <span className={collapsed ? "sr-only" : "text-sm font-semibold tracking-tight whitespace-nowrap"}>Accredian</span>
    </span>
  );
}

/** Accredian wordmark for the signed-in application shell. */
function ShellBrand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground" aria-hidden>
        A
      </span>
      {!collapsed ? (
        <span className="leading-tight whitespace-nowrap">
          <span className="block text-sm font-semibold tracking-tight">Accredian</span>
          <span className="block text-xs text-muted-foreground">Assessment Platform</span>
        </span>
      ) : null}
    </span>
  );
}

function SidebarNav({ role, collapsed, onNavigate }: { role: Role; collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV[role].map((item) => {
        const active = isActive(pathname, item.href, HOME[role]);
        const link = (
          <Link
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
              active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-muted",
              collapsed && "justify-center px-0",
            )}
          >
            <item.icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
            {!collapsed ? <span className="truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
          </Link>
        );
        return collapsed ? (
          <Tooltip key={item.href}>
            <TooltipTrigger render={link} />
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ) : (
          <div key={item.href}>{link}</div>
        );
      })}
    </nav>
  );
}

function SidebarFooter({ role, collapsed, onNavigate }: { role: Role; collapsed: boolean; onNavigate?: () => void }) {
  const user = useAuthUser();
  return (
    <div className="grid gap-2 border-t pt-3">
      <Link
        href={HELP[role]}
        onClick={onNavigate}
        className={cn("flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground hover:bg-muted", collapsed && "justify-center px-0")}
      >
        <HelpCircle className="size-4 text-muted-foreground" aria-hidden />
        {!collapsed ? "Help & Support" : <span className="sr-only">Help & Support</span>}
      </Link>
      <div className={cn("flex items-center gap-2.5 px-1.5", collapsed && "justify-center px-0")}>
        <Avatar size="sm">
          <AvatarFallback className="text-[10px]">{initials(user.name)}</AvatarFallback>
        </Avatar>
        {!collapsed ? (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted-foreground">{ROLE_LABEL[user.role]}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProfileMenu({ role }: { role: Role }) {
  const user = useAuthUser();
  const router = useRouter();
  const [signingOut, startSignOut] = useTransition();
  const base = HOME[role];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted" aria-label="Account menu">
        <Avatar size="sm">
          <AvatarFallback className="text-[10px]">{initials(user.name)}</AvatarFallback>
        </Avatar>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-sm font-medium">{user.name}</span>
          <span className="block text-xs text-muted-foreground">{ROLE_LABEL[user.role]}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="text-sm font-medium text-foreground">{user.name}</div>
            <div className="text-xs font-normal text-muted-foreground">{user.email}</div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push(`${base}/profile`)}>
          <UserRound /> Profile
        </DropdownMenuItem>
        {role === "admin" ? (
          <DropdownMenuItem onClick={() => router.push("/admin/settings")}>
            <Settings /> Settings
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => router.push(HELP[role])}>
          <HelpCircle /> Help
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={signingOut}
          onClick={() =>
            startSignOut(async () => {
              // Revokes the server session, clears the cookie and redirects to /login.
              await logoutAction();
            })
          }
        >
          <LogOut /> {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Chrome for a protected area. The layout has already verified the session and role server-side. */
export function AppShell({ role, children }: { role: Role; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-sidebar px-3 py-4 transition-[width] duration-200 lg:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className={cn("mb-5 flex items-center justify-between px-1", collapsed && "justify-center")}>
          <Link href={HOME[role]} aria-label="Accredian Assessment Platform home">
            <ShellBrand collapsed={collapsed} />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav role={role} collapsed={collapsed} />
        </div>
        <SidebarFooter role={role} collapsed={collapsed} />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-3">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="mb-4 px-1 pt-1">
            <ShellBrand />
          </div>
          <div className="flex-1">
            <SidebarNav role={role} collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </div>
          <SidebarFooter role={role} collapsed={false} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
                  {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                </Button>
              }
            />
            <TooltipContent>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
          </Tooltip>
          <div className="ml-auto flex items-center gap-1">
            <ProfileMenu role={role} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
