"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Eye, FileSpreadsheet, Loader2, Plus, Upload, Users } from "lucide-react";
import { Field, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { ImportLearnersDialog, makeLearners } from "@/components/proto/import-learners-dialog";
import { EmptyState, MetricCard, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatNumber } from "@/prototype/lib/format";
import { newId, useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Batch } from "@/prototype/types";

/** What the simulated CSV "contains". */
const CSV_FILE = "PM_Batch_01.csv";
const CSV_TOTAL = 48;
const CSV_ERRORS = [{ row: 23, value: "rohan.mehta@", reason: "Invalid email address" }];
const CSV_SAMPLE = [
  ["Ananya Iyer", "ananya.iyer@learner.example.com"],
  ["Kabir Nair", "kabir.nair@learner.example.com"],
  ["Meera Gupta", "meera.gupta@learner.example.com"],
];

type UploadPhase = "none" | "processing" | "done";

function ImportBatchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const s = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const { addBatch } = useProtoActions();
  const [name, setName] = useState("");
  const [courseId, setCourseId] = useState("");
  const [phase, setPhase] = useState<UploadPhase>("none");
  const [progress, setProgress] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName("");
    setCourseId("");
    setPhase("none");
    setProgress(0);
    setReviewing(false);
    setErrors({});
    setSaving(false);
  };
  const close = (o: boolean) => {
    if (saving) return;
    if (!o) reset();
    onOpenChange(o);
  };

  function upload() {
    setPhase("processing");
    setProgress(10);
    setErrors((e) => ({ ...e, csv: "" }));
    let p = 10;
    const t = setInterval(() => {
      p += 30;
      setProgress(Math.min(100, p));
      if (p >= 100) {
        clearInterval(t);
        setPhase("done");
      }
    }, 300);
  }

  function submit() {
    const e: Record<string, string> = {};
    if (name.trim().length < 3) e.name = "Enter a batch name.";
    else if (s.batches.some((b) => b.name.toLowerCase() === name.trim().toLowerCase())) e.name = "A batch with this name already exists.";
    if (!courseId) e.courseId = "Choose a course.";
    if (phase !== "done") e.csv = "Upload the learner CSV.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    setTimeout(() => {
      // A real backend would generate the batch ID; it is never shown to admins.
      const id = newId("b");
      const learners = makeLearners(id, CSV_TOTAL - CSV_ERRORS.length);
      addBatch(
        { id, label: name.trim(), name: name.trim(), courseId, createdAt: new Date().toISOString(), status: "Active", learnerIds: learners.map((l) => l.id) },
        learners,
      );
      toast.success("Batch imported successfully.", `${name.trim()} · ${learners.length} learners (${CSV_ERRORS.length} row skipped).`);
      setSaving(false);
      close(false);
    }, 800);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import batch</DialogTitle>
          <DialogDescription>Create a batch and add its learners from a CSV file.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Batch name" htmlFor="bname" required error={errors.name || undefined}>
            <Input id="bname" value={name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: "" })); }} placeholder="Product Management — July 2026 — Batch 01" aria-invalid={!!errors.name || undefined} />
          </Field>
          <Field label="Course" htmlFor="bcourse" required error={errors.courseId || undefined}>
            <SelectField id="bcourse" value={courseId} onChange={(v) => { setCourseId(v); setErrors((x) => ({ ...x, courseId: "" })); }} placeholder="Select a course" options={s.courses.map((c) => ({ value: c.id, label: c.name }))} invalid={!!errors.courseId} />
          </Field>
          <Field label="Learner CSV" required error={errors.csv || undefined}>
            {phase === "none" ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-3">
                <FileSpreadsheet className="size-5 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  Required columns: <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">name,email</code>
                </div>
                <Button variant="outline" size="sm" onClick={upload}>
                  <Upload /> Upload CSV
                </Button>
              </div>
            ) : phase === "processing" ? (
              <div className="grid gap-2 rounded-lg border px-3 py-3" aria-live="polite">
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin text-primary" /> Reading {CSV_FILE}…
                </p>
                <Progress value={progress} />
              </div>
            ) : (
              <div className="rounded-lg border">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-3 text-sm sm:grid-cols-4">
                  <div className="col-span-2 sm:col-span-4">
                    <dt className="text-xs text-muted-foreground">File</dt>
                    <dd className="font-medium">{CSV_FILE}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Learners detected</dt>
                    <dd className="font-medium tabular-nums">{CSV_TOTAL}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Valid records</dt>
                    <dd className="flex items-center gap-1 font-medium text-emerald-700 tabular-nums">
                      <CheckCircle2 className="size-3.5" /> {CSV_TOTAL - CSV_ERRORS.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Errors</dt>
                    <dd className="flex items-center gap-1 font-medium text-amber-700 tabular-nums">
                      <AlertTriangle className="size-3.5" /> {CSV_ERRORS.length}
                    </dd>
                  </div>
                  <div className="flex items-end justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setReviewing((r) => !r)} aria-expanded={reviewing}>
                      {reviewing ? "Hide review" : "Review Import"}
                    </Button>
                  </div>
                </dl>
                {reviewing ? (
                  <div className="border-t text-xs">
                    <table className="w-full">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">Row</th>
                          <th className="px-3 py-1.5 text-left font-medium">name / email</th>
                          <th className="px-3 py-1.5 text-left font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {CSV_ERRORS.map((e) => (
                          <tr key={e.row} className="border-t bg-amber-50/60">
                            <td className="px-3 py-1.5 tabular-nums">{e.row}</td>
                            <td className="px-3 py-1.5 font-mono">{e.value}</td>
                            <td className="px-3 py-1.5 text-amber-800">{e.reason} — will be skipped</td>
                          </tr>
                        ))}
                        {CSV_SAMPLE.map(([n, em], i) => (
                          <tr key={em} className="border-t">
                            <td className="px-3 py-1.5 tabular-nums">{i + 2}</td>
                            <td className="px-3 py-1.5">
                              {n} · <span className="font-mono">{em}</span>
                            </td>
                            <td className="px-3 py-1.5 text-emerald-700">Valid</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="border-t px-3 py-1.5 text-muted-foreground">Showing the error and the first 3 valid rows.</p>
                  </div>
                ) : null}
                <div className="flex justify-end border-t px-3 py-2">
                  <Button variant="ghost" size="xs" onClick={() => { setPhase("none"); setReviewing(false); }}>
                    Replace file
                  </Button>
                </div>
              </div>
            )}
          </Field>
          {courseId && phase === "done" ? (
            <p className="text-xs text-muted-foreground">
              {CSV_TOTAL - CSV_ERRORS.length} learners will be added to a new {lookup.course(courseId)?.name} batch and invited by email (simulated).
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || phase === "processing"}>
            {saving ? "Importing…" : "Import Batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BatchesPage() {
  const s = useProto();
  const lookup = useLookups();
  const router = useRouter();
  const toast = useToast();
  const { addLearners } = useProtoActions();
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importFor, setImportFor] = useState<Batch | null>(null);

  const rows = useMemo(
    () =>
      s.batches
        .filter((b) => (course ? b.courseId === course : true))
        .filter((b) => (status ? b.status === status : true))
        .filter((b) => (q.trim() ? `${b.label} ${b.name}`.toLowerCase().includes(q.trim().toLowerCase()) : true))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [s.batches, course, status, q],
  );
  const pager = usePagination(rows, 10);
  const totalLearners = s.batches.reduce((n, b) => n + b.learnerIds.length, 0);

  return (
    <>
      <PageHeader
        title="Batches & Learners"
        description="Cohorts of learners that assessments are assigned to."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> Import Batch
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Batches" value={s.batches.length} />
        <MetricCard label="Active batches" value={s.batches.filter((b) => b.status === "Active").length} />
        <MetricCard label="Learners" value={formatNumber(totalLearners)} />
        <MetricCard label="Pending invitations" value={formatNumber(s.learners.filter((l) => l.status === "Invited").length)} tone="attention" />
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_12rem_10rem]">
        <SearchInput value={q} onChange={setQ} placeholder="Search batches…" />
        <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={s.courses.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={["Active", "Upcoming", "Completed"].map((x) => ({ value: x, label: x }))} />
      </div>

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={Users} title="No batches match" description="Try a different search or import a batch." />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Batch Name</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead className="text-right">Learners</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created On</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((b) => (
                  <TableRow key={b.id} className="cursor-pointer" onClick={() => router.push(`/admin/batches/${b.id}`)}>
                    <TableCell className="pl-4 font-medium">{b.name}</TableCell>
                    <TableCell className="text-muted-foreground">{lookup.course(b.courseId)?.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(b.learnerIds.length)}</TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(b.createdAt)}</TableCell>
                    <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <RowActions
                        label={`Actions for ${b.name}`}
                        actions={[
                          { label: "View", icon: Eye, onSelect: () => router.push(`/admin/batches/${b.id}`) },
                          { label: "Import learners", icon: Upload, onSelect: () => setImportFor(b) },
                          { label: "Export learners", icon: Download, onSelect: () => toast.comingSoon("Exporting learner lists") },
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

      <ImportBatchDialog open={createOpen} onOpenChange={setCreateOpen} />

      <ImportLearnersDialog
        open={importFor !== null}
        onOpenChange={(o) => !o && setImportFor(null)}
        batchName={importFor?.label ?? ""}
        onImport={(mode, single) => {
          if (!importFor) return;
          const list = mode === "csv" ? makeLearners(importFor.id, 12, importFor.learnerIds.length) : [{ id: newId("l"), name: single!.name, email: single!.email, batchId: importFor.id, status: "Invited" as const }];
          addLearners(importFor.id, list);
          toast.success(`${list.length} learner${list.length === 1 ? "" : "s"} added to ${importFor.label}`, "Invitations queued (simulated).");
        }}
      />
    </>
  );
}
