"use client";

import { useMemo, useState } from "react";
import { Mail, Plus, ShieldCheck, UserCheck, UserRound, UserX } from "lucide-react";
import { cn } from "cn";
import { Field, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRelative, initials } from "@/prototype/lib/format";
import { DEMO_DAY_START } from "@/prototype/lib/random";
import { newId, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { UserRole, UserStatus } from "@/prototype/types";

const TABS: { key: "all" | UserRole; label: string }[] = [
  { key: "all", label: "All Users" },
  { key: "Administrator", label: "Administrators" },
  { key: "Examiner", label: "Examiners" },
  { key: "Doctor / Reviewer", label: "Doctors / Reviewers" },
];
const ROLES: UserRole[] = ["Administrator", "Examiner", "Doctor / Reviewer"];
const ROLE_HELP: Record<UserRole, string> = {
  Administrator: "Full access: papers, assessments, batches, users and settings.",
  Examiner: "Evaluates subjective answers for assigned assessments.",
  "Doctor / Reviewer": "Reviews question papers for academic accuracy before approval.",
};

export default function UsersPage() {
  const s = useProto();
  const toast = useToast();
  const { addUser, updateUser, addExaminer } = useProtoActions();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; email: string; role: UserRole | ""; status: UserStatus }>({ name: "", email: "", role: "", status: "Active" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const rows = useMemo(
    () =>
      s.users
        .filter((u) => (tab === "all" ? true : u.role === tab))
        .filter((u) => (q.trim() ? `${u.name} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [s.users, tab, q],
  );
  const pager = usePagination(rows, 12);
  const now = DEMO_DAY_START + 12 * 3600000;

  function create() {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 3) e.name = "Enter the user’s full name.";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email address.";
    else if (s.users.some((u) => u.email === form.email.trim().toLowerCase())) e.email = "A user with this email already exists.";
    if (!form.role) e.role = "Choose a role.";
    setErrors(e);
    if (Object.keys(e).length || !form.role) return;
    const id = newId("u");
    const email = form.email.trim().toLowerCase();
    addUser({ id, name: form.name.trim(), email, role: form.role, status: form.status, lastActive: "" });
    if (form.role === "Examiner") addExaminer({ id: `e-${id}`, name: form.name.trim(), email, specialization: "General", status: form.status === "Suspended" ? "Inactive" : form.status });
    setOpen(false);
    setForm({ name: "", email: "", role: "", status: "Active" });
    toast.success("User created successfully", `${email} · ${form.role}`);
  }

  return (
    <>
      <PageHeader
        title="Users & Roles"
        description="Staff accounts and what each role can do. Learners are managed in Batches & Learners."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> Create User
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap", tab === t.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{t.key === "all" ? s.users.length : s.users.filter((u) => u.role === t.key).length}</span>
          </button>
        ))}
      </div>
      <SearchInput value={q} onChange={setQ} placeholder="Search users…" className="mb-4 max-w-sm" />

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={UserRound} title="No users match" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2.5">
                        <Avatar size="sm">
                          <AvatarFallback className="text-[10px]">{initials(u.name)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium">{u.name}</div>
                          <div className="text-xs text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        {u.role === "Administrator" ? <ShieldCheck className="size-3.5 text-primary" /> : null}
                        {u.role}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={u.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.lastActive ? formatRelative(u.lastActive, now) : "Never"}</TableCell>
                    <TableCell className="pr-4 text-right">
                      <RowActions
                        label={`Actions for ${u.name}`}
                        actions={[
                          { label: "Resend invitation", icon: Mail, disabled: u.status !== "Invited", onSelect: () => toast.success("Invitation resent", `${u.email} (simulated).`) },
                          u.status === "Suspended"
                            ? { label: "Reactivate", icon: UserCheck, onSelect: () => { updateUser(u.id, { status: "Active" }); toast.success(`${u.name} reactivated`); } }
                            : {
                                label: "Suspend",
                                icon: UserX,
                                destructive: true,
                                disabled: u.email === s.session?.email,
                                onSelect: () => { updateUser(u.id, { status: "Suspended" }); toast.success(`${u.name} suspended`, "They can no longer sign in."); },
                              },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination {...pager} />
          </>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>No password is set here — the user receives an invitation to sign in (simulated).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="Name" htmlFor="un" error={errors.name}>
              <Input id="un" value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setErrors((x) => ({ ...x, name: "" })); }} />
            </Field>
            <Field label="Email" htmlFor="ue" error={errors.email}>
              <Input id="ue" type="email" value={form.email} onChange={(e) => { setForm((f) => ({ ...f, email: e.target.value })); setErrors((x) => ({ ...x, email: "" })); }} />
            </Field>
            <Field label="Role" htmlFor="ur" error={errors.role} hint={form.role ? ROLE_HELP[form.role] : undefined}>
              <SelectField id="ur" value={form.role} onChange={(v) => { setForm((f) => ({ ...f, role: v as UserRole })); setErrors((x) => ({ ...x, role: "" })); }} placeholder="Select a role" options={ROLES.map((r) => ({ value: r, label: r }))} />
            </Field>
            <Field label="Status" htmlFor="us">
              <SelectField id="us" value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v as UserStatus }))} options={["Active", "Invited", "Suspended"].map((x) => ({ value: x, label: x }))} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create}>Create User</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
