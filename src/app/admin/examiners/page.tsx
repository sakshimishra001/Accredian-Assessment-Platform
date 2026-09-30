"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Eye, Mail, Plus, UserCheck, UserCog, UserX } from "lucide-react";
import { Field, SearchInput, SelectField } from "@/components/proto/controls";
import { EmptyState, MetricCard, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { newId, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

export default function ExaminersPage() {
  const s = useProto();
  const router = useRouter();
  const toast = useToast();
  const { addExaminer, updateExaminer, addUser } = useProtoActions();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", specialization: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const stats = (id: string) => {
    const evs = s.evaluations.filter((e) => e.examinerId === id);
    return {
      assigned: s.assessments.filter((a) => a.examinerIds.includes(id)).length,
      pending: evs.filter((e) => e.status !== "Completed").length,
      completed: evs.filter((e) => e.status === "Completed").length,
    };
  };

  const rows = useMemo(
    () =>
      s.examiners
        .filter((e) => (status ? e.status === status : true))
        .filter((e) => (q.trim() ? `${e.name} ${e.email} ${e.specialization}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [s.examiners, status, q],
  );

  function submit() {
    const e: Record<string, string> = {};
    if (form.name.trim().length < 3) e.name = "Enter the examiner’s full name.";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = "Enter a valid email address.";
    else if (s.examiners.some((x) => x.email === form.email.trim().toLowerCase())) e.email = "An examiner with this email already exists.";
    if (!form.specialization.trim()) e.specialization = "Enter a specialization.";
    setErrors(e);
    if (Object.keys(e).length) return;
    const id = newId("e");
    const email = form.email.trim().toLowerCase();
    addExaminer({ id, name: form.name.trim(), email, specialization: form.specialization.trim(), status: "Invited" });
    addUser({ id: `u-${id}`, name: form.name.trim(), email, role: "Examiner", status: "Invited", lastActive: "" });
    setOpen(false);
    setForm({ name: "", email: "", specialization: "" });
    toast.success("Examiner added", `An invitation was sent to ${email} (simulated).`);
  }

  const pendingTotal = s.evaluations.filter((e) => e.status !== "Completed").length;

  return (
    <>
      <PageHeader
        title="Examiners"
        description="Subject experts who evaluate subjective answers."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> Add Examiner
          </Button>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Examiners" value={s.examiners.length} />
        <MetricCard label="Active" value={s.examiners.filter((e) => e.status === "Active").length} />
        <MetricCard label="Pending evaluations" value={pendingTotal} tone="attention" />
        <MetricCard label="Completed evaluations" value={s.evaluations.filter((e) => e.status === "Completed").length} />
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_10rem]">
        <SearchInput value={q} onChange={setQ} placeholder="Search examiners…" />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={["Active", "Invited", "Inactive"].map((x) => ({ value: x, label: x }))} />
      </div>

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={UserCog} title="No examiners match" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Specialization</TableHead>
                <TableHead className="text-right">Assigned Assessments</TableHead>
                <TableHead className="text-right">Pending Evaluations</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => {
                const st = stats(e.id);
                return (
                  <TableRow key={e.id} className="cursor-pointer" onClick={() => router.push(`/admin/examiners/${e.id}`)}>
                    <TableCell className="pl-4 font-medium">{e.name}</TableCell>
                    <TableCell className="text-muted-foreground">{e.email}</TableCell>
                    <TableCell className="text-muted-foreground">{e.specialization}</TableCell>
                    <TableCell className="text-right tabular-nums">{st.assigned}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {st.pending ? <span className="font-medium text-amber-700">{st.pending}</span> : 0}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={e.status} />
                    </TableCell>
                    <TableCell className="pr-4 text-right" onClick={(ev) => ev.stopPropagation()}>
                      <RowActions
                        label={`Actions for ${e.name}`}
                        actions={[
                          { label: "View", icon: Eye, onSelect: () => router.push(`/admin/examiners/${e.id}`) },
                          { label: "Send reminder", icon: Mail, disabled: st.pending === 0, onSelect: () => toast.success("Reminder sent", `${e.name} · ${st.pending} pending (simulated).`) },
                          e.status === "Inactive"
                            ? { label: "Reactivate", icon: UserCheck, onSelect: () => { updateExaminer(e.id, { status: "Active" }); toast.success(`${e.name} reactivated`); } }
                            : { label: "Deactivate", icon: UserX, destructive: true, onSelect: () => { updateExaminer(e.id, { status: "Inactive" }); toast.success(`${e.name} deactivated`); } },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add examiner</DialogTitle>
            <DialogDescription>The examiner receives an invitation to the examiner portal (simulated).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="Full name" htmlFor="en" error={errors.name}>
              <Input id="en" value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setErrors((x) => ({ ...x, name: "" })); }} />
            </Field>
            <Field label="Email" htmlFor="ee" error={errors.email}>
              <Input id="ee" type="email" value={form.email} onChange={(e) => { setForm((f) => ({ ...f, email: e.target.value })); setErrors((x) => ({ ...x, email: "" })); }} />
            </Field>
            <Field label="Specialization" htmlFor="es" error={errors.specialization} hint="e.g. Product Management, Statistics">
              <Input id="es" value={form.specialization} onChange={(e) => { setForm((f) => ({ ...f, specialization: e.target.value })); setErrors((x) => ({ ...x, specialization: "" })); }} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit}>Add examiner</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
