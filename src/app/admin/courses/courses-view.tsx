"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { BookOpen, Pencil, Plus, Power } from "lucide-react";
import { ConfirmDialog, Field, SearchInput } from "@/components/proto/controls";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { CourseRow } from "@/lib/academic/view";
import { formatDate, formatNumber } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { createCourseAction, setCourseActiveAction, updateCourseAction } from "@/server/actions/academic";

type FieldErrors = Record<string, string[] | undefined>;

/** Create (no `course`) or edit a course: code, name, description. */
function CourseDialog({ course, onClose }: { course: CourseRow | null; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState(course?.code ?? "");
  const [name, setName] = useState(course?.name ?? "");
  const [description, setDescription] = useState(course?.description ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setFormError(null);
    startTransition(async () => {
      const input = { code, name, description };
      const result = course ? await updateCourseAction(course.id, input) : await createCourseAction(input);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.fieldErrors ? null : result.error);
        return;
      }
      toast.success(course ? "Course updated" : "Course created", name.trim());
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{course ? "Edit course" : "New course"}</DialogTitle>
          <DialogDescription>Courses group batches, question papers and assessments.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field label="Code" htmlFor="c-code" required error={errors.code?.[0]}>
              <Input id="c-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="AIL" aria-invalid={!!errors.code || undefined} />
            </Field>
            <Field label="Name" htmlFor="c-name" required error={errors.name?.[0]}>
              <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="AI for Leaders" aria-invalid={!!errors.name || undefined} />
            </Field>
          </div>
          <Field label="Description (optional)" htmlFor="c-desc" error={errors.description?.[0]}>
            <Textarea id="c-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : course ? "Save course" : "Create course"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CoursesView({ courses }: { courses: CourseRow[] }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<CourseRow | "new" | null>(null);
  const [deactivating, setDeactivating] = useState<CourseRow | null>(null);
  const [, startTransition] = useTransition();

  const rows = useMemo(
    () => courses.filter((c) => (q.trim() ? `${c.code} ${c.name}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [courses, q],
  );

  function setActive(c: CourseRow, active: boolean) {
    startTransition(async () => {
      const result = await setCourseActiveAction(c.id, active);
      if (result.ok) toast.success(active ? "Course activated" : "Course deactivated", c.name);
      else toast.error("That didn’t work", result.error);
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Batches & Learners", href: "/admin/batches" }, { label: "Courses" }]}
        title="Courses"
        description="Programmes that batches, question papers and assessments belong to."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus /> New Course
          </Button>
        }
      />

      <div className="mb-4 max-w-md">
        <SearchInput value={q} onChange={setQ} placeholder="Search courses…" />
      </div>

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={BookOpen}
            title={courses.length === 0 ? "No courses yet" : "No courses match"}
            description={courses.length === 0 ? "Create a course, then add batches to it." : "Try a different search."}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Course</TableHead>
                <TableHead className="text-right">Batches</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created On</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4 font-mono text-xs">{c.code}</TableCell>
                  <TableCell>
                    <span className="block font-medium">{c.name}</span>
                    {c.description ? <span className="block max-w-xl truncate text-xs text-muted-foreground">{c.description}</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Link href="/admin/batches" className="hover:underline">
                      {formatNumber(c.batchCount)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.isActive ? "Active" : "Inactive"} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <RowActions
                      label={`Actions for ${c.name}`}
                      actions={[
                        { label: "Edit", icon: Pencil, onSelect: () => setEditing(c) },
                        c.isActive
                          ? { label: "Deactivate", icon: Power, destructive: true, separatorBefore: true, onSelect: () => setDeactivating(c) }
                          : { label: "Activate", icon: Power, separatorBefore: true, onSelect: () => setActive(c, true) },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {editing ? <CourseDialog course={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(o) => !o && setDeactivating(null)}
        title={`Deactivate ${deactivating?.name}?`}
        description="Existing batches, learners and assessments are kept, but no new batches can be added to an inactive course."
        confirmLabel="Deactivate course"
        destructive
        onConfirm={() => deactivating && setActive(deactivating, false)}
      />
    </>
  );
}
