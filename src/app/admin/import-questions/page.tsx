"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Download, FileStack, Plus, TableProperties, X } from "lucide-react";
import { IMPORT_METHODS } from "@/components/proto/import-methods";
import { Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { usePaperActions } from "@/components/proto/paper-actions";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/prototype/lib/format";
import { paperTotals } from "@/prototype/lib/paper";
import { useLookups, useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { PaperStatus } from "@/prototype/types";

const TEMPLATE_COLUMNS: [string, string, string][] = [
  ["Section", "Section A", "Section name the question belongs to"],
  ["Question No.", "1, 1(a), 2", "Use 1(a), 1(b) for sub-questions"],
  ["Type", "MCQ_SINGLE", "MCQ_SINGLE, MCQ_MULTI, TRUE_FALSE, SHORT_ANSWER, LONG_ANSWER, COMPREHENSION, CASE_STUDY"],
  ["Question Text", "Which framework…", "Required"],
  ["Passage", "(optional)", "For comprehension / case-study parent rows"],
  ["Option A–F", "RICE", "Objective questions only"],
  ["Correct Answer", "B or A,C", "Letters; comma-separated for multiple"],
  ["Marks", "2", "Required, ≥ 0"],
  ["Compulsory", "Yes / No", "Defaults to the section rule"],
];

const STATUSES: PaperStatus[] = ["Draft", "Processing", "Needs Review", "Approved", "Archived"];

function ImportQuestionsPage() {
  const s = useProto();
  const lookup = useLookups();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { rowActions } = usePaperActions();
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [batch, setBatch] = useState("");
  const [status, setStatus] = useState(STATUSES.find((x) => x === params.get("status")) ?? "");
  const [templateOpen, setTemplateOpen] = useState(false);

  const rows = useMemo(
    () =>
      s.papers
        .filter((p) => (status ? p.status === status : p.status !== "Archived"))
        .filter((p) => (course ? p.courseId === course : true))
        .filter((p) => (batch ? p.batchId === batch : true))
        .filter((p) => (q.trim() ? `${p.name} ${p.subject}`.toLowerCase().includes(q.trim().toLowerCase()) : true))
        .sort((a, b) => b.importedOn.localeCompare(a.importedOn)),
    [s.papers, status, course, batch, q],
  );
  const pager = usePagination(rows, 10);
  const filtersActive = Boolean(q || course || batch || status);
  const count = (st: PaperStatus) => s.papers.filter((p) => p.status === st).length;

  return (
    <>
      <PageHeader
        title="Import Questions"
        description="Upload or create structured question papers for assessments."
        actions={
          <Link href="/admin/import-questions/new" className={buttonVariants()}>
            <Plus /> Import Question Paper
          </Link>
        }
      />

      <section className="grid gap-3 md:grid-cols-3" aria-label="Import options">
        {IMPORT_METHODS.map((m) => (
          <div key={m.key} className="flex flex-col rounded-lg border bg-card p-4">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <m.icon className="size-5" aria-hidden />
              </span>
              <span className="text-sm font-semibold">{m.title}</span>
            </div>
            <p className="mt-3 flex-1 text-sm text-muted-foreground">{m.body}</p>
            <Link href={`/admin/import-questions/new?method=${m.key}`} className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4 self-start" })}>
              Import {m.key === "excel" ? "Excel" : m.key === "word" ? "Word" : "PDF"}
            </Link>
          </div>
        ))}
      </section>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => toast.success("Template downloaded", "Question_Paper_Template.xlsx (simulated download — prototype only).")}>
          <Download /> Download Excel Template
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setTemplateOpen(true)}>
          <TableProperties /> View Template Format
        </Button>
      </div>

      <Panel className="mt-6" title="Question Paper Library" description={`${s.papers.length} papers · ${count("Approved")} approved · ${count("Needs Review")} need review`} bodyClassName="p-0">
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_repeat(3,minmax(0,11rem))_auto]">
          <SearchInput value={q} onChange={setQ} placeholder="Search question papers…" />
          <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={s.courses.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField value={batch} onChange={setBatch} placeholder="All batches" ariaLabel="Batch" options={s.batches.map((b) => ({ value: b.id, label: b.label }))} />
          <SelectField value={status} onChange={(v) => setStatus(v as PaperStatus | "")} placeholder="All except archived" ariaLabel="Status" options={STATUSES.map((x) => ({ value: x, label: `${x} (${count(x)})` }))} />
          {filtersActive ? (
            <Button variant="ghost" onClick={() => { setQ(""); setCourse(""); setBatch(""); setStatus(""); }}>
              <X /> Clear
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            className="m-4 mt-0"
            icon={FileStack}
            title="No question papers match"
            description="Adjust the filters or import a new paper."
            action={<Link href="/admin/import-questions/new" className={buttonVariants()}>Import Question Paper</Link>}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Question Paper</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Questions</TableHead>
                  <TableHead className="text-right">Sections</TableHead>
                  <TableHead className="text-right">Max Marks</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Imported On</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((p) => {
                  const t = paperTotals(p);
                  return (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/admin/import-questions/${p.id}`)}>
                      <TableCell className="pl-4">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {p.source === "Manual" ? "Created manually" : `${p.source} import`}
                          {t.needsReview ? <span className="text-amber-700"> · {t.needsReview} flagged</span> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{lookup.course(p.courseId)?.name}</TableCell>
                      <TableCell className="text-muted-foreground">{p.subject}</TableCell>
                      <TableCell className="text-muted-foreground">{lookup.batch(p.batchId)?.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.questions}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.sections}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.marks}</TableCell>
                      <TableCell className="text-muted-foreground">{p.version}</TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(p.importedOn)}</TableCell>
                      <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <RowActions actions={rowActions(p)} label={`Actions for ${p.name}`} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pagination {...pager} />
          </>
        )}
      </Panel>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Excel template format</DialogTitle>
            <DialogDescription>One row per question. Sub-questions and case-study parts use their own rows under the parent.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Column</th>
                  <th className="px-3 py-2 text-left font-medium">Example</th>
                  <th className="px-3 py-2 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {TEMPLATE_COLUMNS.map(([c, e, n]) => (
                  <tr key={c} className="border-t">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{c}</td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{e}</td>
                    <td className="px-3 py-2 text-muted-foreground">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>
              Close
            </Button>
            <Button onClick={() => { setTemplateOpen(false); toast.success("Template downloaded", "Question_Paper_Template.xlsx (simulated download — prototype only)."); }}>
              <Download /> Download template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default withSuspense(ImportQuestionsPage);
