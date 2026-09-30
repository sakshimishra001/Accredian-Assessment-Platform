import type { Role } from "@/lib/auth/rbac";

export interface NavItem {
  label: string;
  href: string;
}

/** Sidebar entries per role. New feature areas are added here as they are built. */
export const NAVIGATION: Record<Role, NavItem[]> = {
  ADMIN: [
    { label: "Dashboard", href: "/admin" },
    { label: "Assessments", href: "/admin/assessments" },
    { label: "Question bank", href: "/admin/questions" },
  ],
  LEARNER: [{ label: "Dashboard", href: "/learner" }],
  EXAMINER: [{ label: "Dashboard", href: "/examiner" }],
};
