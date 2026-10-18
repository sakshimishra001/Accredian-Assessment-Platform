"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { List, Pencil, Plus, Power, Upload, UserCheck, UserMinus, UserX, Users } from "lucide-react";
import { ConfirmDialog, Field, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { ImportLearnersDialog } from "@/components/proto/import-learners-dialog";
import { EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BatchLearnerRow, BatchRow } from "@/lib/academic/view";
import { formatDate, formatNumber } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { removeLearnerFromBatchAction, setBatchActiveAction, setLearnerStatusAction, updateBatchAction } from "@/server/actions/academic";

type FieldErrors = Record<string, string[] | undefined>;

function EditBatchDialog({ open, onOpenChange, batch }: { open: boolean; onOpenChange: (o: boolean) => void; batch: BatchRow }) {
  const toast = useToast();
  const [name, setName] = useState(batch.name);
  const [code, setCode] = useState(batch.code ?? "");
  const [startDate, setStartDate] = useState(batch.startDate);
  const [endDate, setEndDate] = useState(batch.endDate);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setFormError(null);
    startTransition(async () => {
      const result = await updateBatchAction(batch.id, { name, code, startDate, endDate });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors ? null : result.error);
        return;
      }
      toast.success("Batch updated", name.trim());
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit batch</DialogTitle>
          <DialogDescription>{batch.course.name} · the course of a batch can’t be changed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Batch name" htmlFor="eb-name" required error={errors.name?.[0]}>
            <Input id="eb-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name || undefined} />
          </Field>
          <Field label="Batch code (optional)" htmlFor="eb-code" error={errors.code?.[0]}>
            <Input id="eb-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. AIL-SEP26" aria-invalid={!!errors.code || undefined} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date (optional)" htmlFor="eb-start" error={errors.startDate?.[0]}>
              <Input id="eb-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="End date (optional)" htmlFor="eb-end" error={errors.endDate?.[0]}>
              <Input id="eb-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
          </div>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pending = { kind: "remove" | "disable"; learner: BatchLearnerRow } | null;

export function BatchDetailView({ batch, learners }: { batch: BatchRow; learners: BatchLearnerRow[] }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [, startTransition] = useTransition();
  const tableRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () =>
      learners
        .filter((l) => (status ? l.status === status : true))
        .filter((l) => (q.trim() ? `${l.name} ${l.email}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [learners, status, q],
  );
  const pager = usePagination(visible, 12);

  /** Run a server action and report the outcome. The page refreshes with fresh data on success. */
  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: [string, string?]) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) toast.success(...success);
      else toast.error("That didn’t work", result.error);
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Batches & Learners", href: "/admin/batches" }, { label: batch.code ?? batch.name }]}
        title={batch.name}
        meta={<StatusBadge status={batch.status} />}
        description={`${batch.course.name} · created ${formatDate(batch.createdAt)}`}
        actions={
          <>
            <Button variant="outline" onClick={() => tableRef.current?.scrollIntoView({ behavior: "smooth" })}>
              <List /> View Learners
            </Button>
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" onClick={() => (batch.isActive ? setConfirmBatch(true) : run(() => setBatchActiveAction(batch.id, true), ["Batch activated", batch.name]))}>
              <Power /> {batch.isActive ? "Deactivate" : "Activate"}
            </Button>
            <Button onClick={() => setImportOpen(true)} disabled={!batch.isActive || !batch.course.isActive}>
              <Upload /> Import Learners
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Learners" value={formatNumber(learners.length)} />
        <MetricCard label="Active" value={formatNumber(learners.filter((l) => l.status === "Active").length)} />
        <MetricCard label="Inactive" value={formatNumber(learners.filter((l) => l.status === "Inactive").length)} tone="attention" />
        <MetricCard label="Course" value={batch.course.code} />
      </div>

      <Panel
        title="Assessments for this batch"
        className="mb-6"
        actions={
          <Link href="/admin/assessments/new" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Plus /> Create Assessment
          </Link>
        }
      >
        <p className="text-sm text-muted-foreground">Assessments aren’t connected to live batch data yet. They’ll be listed here once the assessment screens use the database.</p>
      </Panel>

      <div ref={tableRef} className="scroll-mt-20">
        <Panel title="Learners" description={`${formatNumber(visible.length)} shown`} bodyClassName="p-0">
          <div className="grid gap-2 p-4 sm:grid-cols-[1fr_10rem]">
            <SearchInput value={q} onChange={setQ} placeholder="Search by name or email…" />
            <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Learner status" options={["Active", "Inactive"].map((x) => ({ value: x, label: x }))} />
          </div>
          {visible.length === 0 ? (
            <EmptyState className="m-4 mt-0" icon={Users} title={learners.length === 0 ? "No learners yet" : "No learners match"} description={learners.length === 0 ? "Add learners one at a time or from a CSV." : undefined} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="w-12 pr-4">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pager.slice.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="pl-4 font-medium">{l.name}</TableCell>
                      <TableCell className="text-muted-foreground">{l.email}</TableCell>
                      <TableCell>
                        <StatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(l.addedAt)}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <RowActions
                          label={`Actions for ${l.name}`}
                          actions={[
                            { label: "Remove from batch", icon: UserMinus, onSelect: () => setConfirm({ kind: "remove", learner: l }) },
                            l.status === "Inactive"
                              ? {
                                  label: "Reactivate learner",
                                  icon: UserCheck,
                                  separatorBefore: true,
                                  onSelect: () => run(() => setLearnerStatusAction(l.id, "ACTIVE", batch.id), [`${l.name} reactivated`, "They can sign in to assessments again."]),
                                }
                              : { label: "Deactivate learner", icon: UserX, destructive: true, separatorBefore: true, onSelect: () => setConfirm({ kind: "disable", learner: l }) },
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
        </Panel>
      </div>

      <ImportLearnersDialog open={importOpen} onOpenChange={setImportOpen} batchId={batch.id} batchName={batch.name} />
      {editOpen ? <EditBatchDialog open={editOpen} onOpenChange={setEditOpen} batch={batch} /> : null}

      <ConfirmDialog
        open={confirm?.kind === "remove"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Remove ${confirm?.learner.name} from this batch?`}
        description="Only this batch membership is removed. The learner’s account, their other batches and any assessment records stay as they are."
        confirmLabel="Remove from batch"
        onConfirm={() => {
          const l = confirm!.learner;
          run(() => removeLearnerFromBatchAction(batch.id, l.id), [`${l.name} removed from ${batch.name}`, "Their account and other batches are unchanged."]);
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "disable"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Deactivate ${confirm?.learner.name}?`}
        description="This disables the learner’s account across the whole platform — every batch and every assessment — and signs them out. It doesn’t remove them from this batch."
        confirmLabel="Deactivate learner"
        destructive
        onConfirm={() => {
          const l = confirm!.learner;
          run(() => setLearnerStatusAction(l.id, "DISABLED", batch.id), [`${l.name} deactivated`, "They can no longer sign in to assessments."]);
        }}
      />
      <ConfirmDialog
        open={confirmBatch}
        onOpenChange={setConfirmBatch}
        title="Deactivate this batch?"
        description="Its learners stay in the batch, but no new learners can be added and it can’t be chosen for new assessments."
        confirmLabel="Deactivate batch"
        destructive
        onConfirm={() => run(() => setBatchActiveAction(batch.id, false), ["Batch deactivated", batch.name])}
      />
    </>
  );
}
