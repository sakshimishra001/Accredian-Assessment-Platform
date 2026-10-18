import type { Metadata } from "next";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listStaff } from "@/server/services/staff";
import { UsersView, type StaffRow } from "./users-view";

export const metadata: Metadata = { title: "Users & Roles" };

/** Staff accounts from PostgreSQL (admin only). Learners are managed in Batches & Learners. */
export default async function UsersPage() {
  const actor = await requireRole(Role.ADMIN);
  const staff = await listStaff(actor);
  const rows: StaffRow[] = staff.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as StaffRow["role"],
    status: u.status,
    hasPassword: u.hasPassword,
    pendingLink: u.pendingLink ? { purpose: u.pendingLink.purpose, expiresAt: u.pendingLink.expiresAt.toISOString() } : null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  }));
  return <UsersView rows={rows} currentUserId={actor.id} />;
}
