"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Eye, Plus, Upload, Users } from "lucide-react";
import { Field, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { ImportLearnersDialog, LearnerCsvPicker, RowErrors, type PickedCsv } from "@/components/proto/import-learners-dialog";
import { EmptyState, MetricCard, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BatchRow, CourseOption } from "@/lib/academic/view";
import { formatDate, formatNumber } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { createBatchAction } from "@/server/actions/academic";

type FieldErrors = Record<string, string[] | undefined>;

/** Create a batch (name + course), optionally with its learners from a CSV — all or nothing. */
function ImportBatchDialog({ open, onOpenChange, courses }: { open: boolean; onOpenChange: (o: boolean) => void; courses: CourseOption[] }) {
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState("");
  const [courseId, setCourseId] = useState("");
  const [csv, setCsv] = useState<PickedCsv | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const activeCourses = courses.filter((c) => c.isActive);

  const close = (o: boolean) => {
    if (pending) return;
    if (!o) {
      setName("");
      setCourseId("");
      setCsv(null);
      setErrors({});
      setFormError(null);
    }
    onOpenChange(o);
  };

  function submit() {
    setFormError(null);
    startTransition(async () => {
      const result = await createBatchAction({ name, courseId }, csv ? { fileName: csv.fileName, content: csv.content } : null);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        const shown = result.fieldErrors && (result.fieldErrors.name || result.fieldErrors.courseId || result.fieldErrors.rows || result.fieldErrors.csv);
        setFormError(shown ? null : result.error);
        return;
      }
      const learners = result.data!.learners;
      toast.success("Batch created.", learners ? `${name.trim()} · ${learners.created + learners.addedExisting} learners added` : name.trim());
      close(false);
      router.push(`/admin/batches/${result.data!.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import batch</DialogTitle>
          <DialogDescription>Create a batch for a course. Add its learners now from a CSV, or later.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Batch name" htmlFor="bname" required error={errors.name?.[0]}>
            <Input
              id="bname"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((x) => ({ ...x, name: undefined }));
              }}
              placeholder="Product Management — July 2026 — Batch 01"
              aria-invalid={!!errors.name || undefined}
            />
          </Field>
          <Field label="Course" htmlFor="bcourse" required error={errors.courseId?.[0]} hint={activeCourses.length === 0 ? "Create a course first." : undefined}>
            <SelectField
              id="bcourse"
              value={courseId}
              onChange={(v) => {
                setCourseId(v);
                setErrors((x) => ({ ...x, courseId: undefined }));
              }}
              placeholder="Select a course"
              options={activeCourses.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))}
              invalid={!!errors.courseId}
            />
          </Field>
          <Field label="Learner CSV (optional)">
            <LearnerCsvPicker value={csv} onChange={setCsv} error={errors.csv?.[0]} />
          </Field>
          <RowErrors messages={errors.rows} />
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Creating…" : csv ? `Create batch with ${csv.rows.length} learners` : "Create batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BatchesView({ courses, batches }: { courses: CourseOption[]; batches: BatchRow[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importFor, setImportFor] = useState<BatchRow | null>(null);

  const rows = useMemo(
    () =>
      batches
        .filter((b) => (course ? b.course.id === course : true))
        .filter((b) => (status ? b.status === status : true))
        .filter((b) => (q.trim() ? `${b.code ?? ""} ${b.name}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [batches, course, status, q],
  );
  const pager = usePagination(rows, 10);
  const enrolments = batches.reduce((n, b) => n + b.learnerCount, 0);

  return (
    <>
      <PageHeader
        title="Batches & Learners"
        description="Cohorts of learners that assessments are assigned to."
        actions={
          <>
            <Link href="/admin/courses" className={buttonVariants({ variant: "outline" })}>
              Manage courses
            </Link>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Import Batch
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Batches" value={batches.length} />
        <MetricCard label="Active batches" value={batches.filter((b) => b.status === "Active").length} />
        <MetricCard label="Learner enrolments" value={formatNumber(enrolments)} />
        <MetricCard label="Courses" value={courses.filter((c) => c.isActive).length} />
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_12rem_10rem]">
        <SearchInput value={q} onChange={setQ} placeholder="Search batches…" />
        <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={courses.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={["Active", "Upcoming", "Completed", "Inactive"].map((x) => ({ value: x, label: x }))} />
      </div>

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={Users}
            title={batches.length === 0 ? "No batches yet" : "No batches match"}
            description={batches.length === 0 ? "Import a batch to get started." : "Try a different search or filter."}
          />
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
                    <TableCell className="text-muted-foreground">{b.course.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(b.learnerCount)}</TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(b.createdAt)}</TableCell>
                    <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <RowActions
                        label={`Actions for ${b.name}`}
                        actions={[
                          { label: "View", icon: Eye, onSelect: () => router.push(`/admin/batches/${b.id}`) },
                          { label: "Import learners", icon: Upload, onSelect: () => setImportFor(b), disabled: !b.isActive },
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

      <ImportBatchDialog open={createOpen} onOpenChange={setCreateOpen} courses={courses} />

      <ImportLearnersDialog open={importFor !== null} onOpenChange={(o) => !o && setImportFor(null)} batchId={importFor?.id ?? ""} batchName={importFor?.name ?? ""} />
    </>
  );
}
