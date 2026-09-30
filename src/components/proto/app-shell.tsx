"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  BookOpenCheck,
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
  Search,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative, initials } from "@/prototype/lib/format";
import { DEMO_DAY_START } from "@/prototype/lib/random";
import { DEMO_USERS, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
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
  reviewer: [{ label: "Review Queue", href: "/reviewer", icon: BookOpenCheck }],
  learner: [
    { label: "Dashboard", href: "/learner", icon: LayoutDashboard },
    { label: "My Assessments", href: "/learner/assessments", icon: GraduationCap },
  ],
};

const HOME: Record<Role, string> = { admin: "/admin", examiner: "/examiner", reviewer: "/reviewer", learner: "/learner" };
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", examiner: "Examiner", reviewer: "Doctor / Reviewer", learner: "Learner" };
const HELP: Record<Role, string> = { admin: "/admin/help", examiner: "/examiner/help", reviewer: "/reviewer/help", learner: "/learner/help" };

function isActive(pathname: string, href: string, home: string) {
  return href === home ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <SquareCheckBig className="size-4" aria-hidden />
      </span>
      {!collapsed ? <span className="text-sm font-semibold tracking-tight whitespace-nowrap">Assessment Platform</span> : null}
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
  const { session } = useProto();
  const user = session ?? DEMO_USERS[role];
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
            <div className="truncate text-xs text-muted-foreground">{ROLE_LABEL[role]}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GlobalSearch({ role }: { role: Role }) {
  const { assessments, papers, batches, examiners } = useProto();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2 || role !== "admin") return [];
    const hits: { label: string; kind: string; href: string }[] = [];
    for (const a of assessments) if (a.name.toLowerCase().includes(term)) hits.push({ label: a.name, kind: "Assessment", href: `/admin/assessments/${a.id}` });
    for (const p of papers) if (p.name.toLowerCase().includes(term)) hits.push({ label: p.name, kind: "Question paper", href: `/admin/import-questions/${p.id}` });
    for (const b of batches) if (b.label.toLowerCase().includes(term) || b.name.toLowerCase().includes(term)) hits.push({ label: b.name, kind: "Batch", href: `/admin/batches/${b.id}` });
    for (const e of examiners) if (e.name.toLowerCase().includes(term)) hits.push({ label: e.name, kind: "Examiner", href: `/admin/examiners/${e.id}` });
    return hits.slice(0, 8);
  }, [q, role, assessments, papers, batches, examiners]);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) go(results[0].href);
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={role === "admin" ? "Search assessments, papers, batches…" : "Search…"}
        aria-label="Search"
        className="h-8 w-full rounded-md border bg-muted/50 pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-3 focus:ring-ring/30"
      />
      {open && q.trim().length >= 2 ? (
        <div className="absolute top-10 left-0 z-50 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">No matches for “{q}”.</p>
          ) : (
            <ul className="py-1">
              {results.map((r) => (
                <li key={r.href}>
                  <button type="button" onClick={() => go(r.href)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted">
                    <span className="truncate">{r.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{r.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Notifications({ role }: { role: Role }) {
  const { notifications } = useProto();
  const { markNotificationRead, markAllNotificationsRead } = useProtoActions();
  const router = useRouter();
  const items = role === "admin" ? notifications : [];
  const unread = items.filter((n) => !n.read).length;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative">
            <Bell />
            {unread ? (
              <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                {unread}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          <button type="button" className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline" disabled={!unread} onClick={markAllNotificationsRead}>
            Mark all as read
          </button>
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">You’re all caught up.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-auto">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => {
                    markNotificationRead(n.id);
                    if (n.href) router.push(n.href);
                  }}
                  className="flex w-full gap-2 px-3 py-2.5 text-left hover:bg-muted"
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{n.title}</span>
                    <span className="block text-xs text-muted-foreground">{n.body}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatRelative(n.time, DEMO_DAY_START + 12 * 3600000)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ProfileMenu({ role }: { role: Role }) {
  const { session } = useProto();
  const { signOut } = useProtoActions();
  const router = useRouter();
  const user = session ?? DEMO_USERS[role];
  const base = HOME[role];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted" aria-label="Account menu">
        <Avatar size="sm">
          <AvatarFallback className="text-[10px]">{initials(user.name)}</AvatarFallback>
        </Avatar>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-sm font-medium">{user.name}</span>
          <span className="block text-xs text-muted-foreground">{ROLE_LABEL[role]}</span>
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
          onClick={() => {
            signOut();
            router.push("/login");
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Makes sure a prototype session exists for this area. A refresh wipes in-memory state, so rather than
 * bouncing the demo back to login we quietly sign in the demo user for the area being viewed.
 */
function useEnsureSession(role: Role) {
  const { session } = useProto();
  const { signIn } = useProtoActions();
  useEffect(() => {
    if (!session || session.role !== role) signIn(DEMO_USERS[role]);
  }, [session, role, signIn]);
}

export function AppShell({ role, children }: { role: Role; children: ReactNode }) {
  useEnsureSession(role);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const toast = useToast();

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-sidebar px-3 py-4 transition-[width] duration-200 lg:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className={cn("mb-5 flex items-center justify-between px-1", collapsed && "justify-center")}>
          <Link href={HOME[role]} aria-label="Assessment Platform home">
            <Logo collapsed={collapsed} />
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
            <Logo />
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
          <GlobalSearch role={role} />
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => toast.info("Prototype mode", "No real authentication, data or backend. Refreshing the page resets everything.")}
                    className="mr-2 hidden items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 ring-1 ring-amber-200 ring-inset sm:inline-flex"
                  >
                    <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                    Prototype mode
                  </button>
                }
              />
              <TooltipContent>Mock data only — refreshing resets all changes</TooltipContent>
            </Tooltip>
            <Notifications role={role} />
            <ProfileMenu role={role} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
