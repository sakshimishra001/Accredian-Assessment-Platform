"use client";

import { useMemo, useState, useTransition } from "react";
import { Copy, KeyRound, Link2, Plus, ShieldCheck, UserCheck, UserRound, UserX } from "lucide-react";
import { cn } from "cn";
import { ConfirmDialog, Field, SearchInput, SelectField } from "@/components/proto/controls";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions, type RowAction } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STAFF_ROLES, type StaffRole } from "@/lib/validation/staff";
import { formatDateTime, initials } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { createStaffAccountAction, reissueInviteAction, resetStaffPasswordAction, setStaffStatusAction } from "@/server/actions/staff";

export interface StaffRow {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  status: "ACTIVE" | "DISABLED";
  hasPassword: boolean;
  pendingLink: { purpose: "INVITE" | "RESET"; expiresAt: string } | null;
  lastLoginAt: string | null;
}

const ROLE_LABEL: Record<StaffRole, string> = { ADMIN: "Administrator", EXAMINER: "Examiner", REVIEWER: "Proctor" };
const ROLE_HELP: Record<StaffRole, string> = {
  ADMIN: "Full access: papers, assessments, batches, results and staff accounts.",
  EXAMINER: "Evaluates written answers of the candidates assigned to them.",
  REVIEWER: "Proctors the assessments they are assigned to (assigned on each assessment’s Proctors tab).",
};
const TABS: { key: "all" | StaffRole; label: string }[] = [
  { key: "all", label: "All staff" },
  { key: "ADMIN", label: "Administrators" },
  { key: "EXAMINER", label: "Examiners" },
  { key: "REVIEWER", label: "Proctors" },
];

/** What the account's status column shows. */
function accountState(u: StaffRow) {
  if (u.status === "DISABLED") return "Disabled";
  if (!u.hasPassword) return u.pendingLink ? "Invited" : "No password";
  return "Active";
}

/** Shows a freshly issued one-time link once, with what the administrator should do with it. */
function LinkDialog({ link, onClose }: { link: { title: string; email: string; url: string; expiresAt: string } | null; onClose: () => void }) {
  const toast = useToast();
  if (!link) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{link.title}</DialogTitle>
          <DialogDescription>
            Send this one-time link to {link.email} through a channel you trust. It lets them set their own password, works once, and expires{" "}
            {formatDateTime(link.expiresAt)} IST. It won’t be shown again — issue a new link if it is lost.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={link.url} aria-label="One-time link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <Button
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(link.url)
                .then(() => toast.success("Link copied"))
                .catch(() => toast.error("Couldn’t copy", "Select the link and copy it manually."))
            }
          >
            <Copy /> Copy
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersView({ rows, currentUserId }: { rows: StaffRow[]; currentUserId: string }) {
  const toast = useToast();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; email: string; role: StaffRole | "" }>({ name: "", email: "", role: "" });
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [link, setLink] = useState<{ title: string; email: string; url: string; expiresAt: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "disable" | "reset"; user: StaffRow } | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = useMemo(
    () =>
      rows
        .filter((u) => (tab === "all" ? true : u.role === tab))
        .filter((u) => (q.trim() ? `${u.name} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [rows, tab, q],
  );

  function create() {
    setFormError(null);
    startTransition(async () => {
      const result = await createStaffAccountAction(form);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors ? null : result.error);
        return;
      }
      setOpen(false);
      setErrors({});
      setLink({ title: "Account created", email: form.email.trim().toLowerCase(), url: result.data!.link.url, expiresAt: new Date(result.data!.link.expiresAt).toISOString() });
      setForm({ name: "", email: "", role: "" });
    });
  }

  function run(promise: Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await promise;
      if (!result.ok) toast.error("Couldn’t update the account", result.error);
      else toast.success(success);
    });
  }

  function issue(user: StaffRow, kind: "reset" | "invite") {
    startTransition(async () => {
      const result = kind === "reset" ? await resetStaffPasswordAction(user.id) : await reissueInviteAction(user.id);
      if (!result.ok) return toast.error("Couldn’t issue a link", result.error);
      setLink({ title: kind === "reset" ? "Password reset" : "New invitation link", email: user.email, url: result.data!.url, expiresAt: new Date(result.data!.expiresAt).toISOString() });
    });
  }

  function actionsFor(u: StaffRow): RowAction[] {
    const self = u.id === currentUserId;
    const out: RowAction[] = [];
    if (u.status === "ACTIVE" && !u.hasPassword) out.push({ label: "New invitation link", icon: Link2, disabled: pending, onSelect: () => issue(u, "invite") });
    if (u.status === "ACTIVE" && u.hasPassword) out.push({ label: "Reset password", icon: KeyRound, disabled: pending || self, onSelect: () => setConfirm({ kind: "reset", user: u }) });
    out.push(
      u.status === "DISABLED"
        ? { label: "Enable", icon: UserCheck, disabled: pending, onSelect: () => run(setStaffStatusAction(u.id, true), `${u.name} can sign in again`) }
        : { label: "Disable", icon: UserX, destructive: true, disabled: pending || self, separatorBefore: out.length > 0, onSelect: () => setConfirm({ kind: "disable", user: u }) },
    );
    return out;
  }

  return (
    <>
      <PageHeader
        title="Users & Roles"
        description="Staff accounts and what each role can do. Learners are managed in Batches & Learners."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> Create user
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
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{t.key === "all" ? rows.length : rows.filter((u) => u.role === t.key).length}</span>
          </button>
        ))}
      </div>
      <SearchInput value={q} onChange={setQ} placeholder="Search staff…" className="mb-4 max-w-sm" />

      <div className="rounded-lg border bg-card">
        {visible.length === 0 ? (
          <EmptyState className="m-4" icon={UserRound} title="No staff accounts match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2.5">
                      <Avatar size="sm">
                        <AvatarFallback className="text-[10px]">{initials(u.name)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-medium">
                          {u.name}
                          {u.id === currentUserId ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      {u.role === "ADMIN" ? <ShieldCheck className="size-3.5 text-primary" /> : null}
                      {ROLE_LABEL[u.role]}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={accountState(u)} />
                    {u.pendingLink && u.status === "ACTIVE" ? (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {u.pendingLink.purpose === "RESET" ? "Reset" : "Invitation"} link until {formatDateTime(u.pendingLink.expiresAt)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Never"}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <RowActions label={`Actions for ${u.name}`} actions={actionsFor(u)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>No password is set here. You’ll get a one-time link for the person to choose their own password.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="Name" htmlFor="un" error={errors.name?.[0]}>
              <Input id="un" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} aria-invalid={!!errors.name || undefined} />
            </Field>
            <Field label="Email" htmlFor="ue" error={errors.email?.[0]}>
              <Input id="ue" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} aria-invalid={!!errors.email || undefined} />
            </Field>
            <Field label="Role" htmlFor="ur" error={errors.role?.[0]} hint={form.role ? ROLE_HELP[form.role] : undefined}>
              <SelectField
                id="ur"
                value={form.role}
                onChange={(v) => setForm((f) => ({ ...f, role: v as StaffRole }))}
                placeholder="Select a role"
                options={STAFF_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              />
            </Field>
            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={create} disabled={pending}>
              {pending ? "Creating…" : "Create user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm?.kind === "disable"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Disable ${confirm?.user.name ?? ""}?`}
        description="They are signed out everywhere at once and can’t sign in until the account is enabled again. Their past work stays."
        confirmLabel="Disable account"
        destructive
        onConfirm={() => confirm && run(setStaffStatusAction(confirm.user.id, false), `${confirm.user.name} disabled`)}
      />
      <ConfirmDialog
        open={confirm?.kind === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Reset ${confirm?.user.name ?? ""}’s password?`}
        description="Their current password stops working and they are signed out everywhere. You’ll get a one-time link for them to choose a new one."
        confirmLabel="Reset password"
        destructive
        onConfirm={() => confirm && issue(confirm.user, "reset")}
      />
      <LinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}
