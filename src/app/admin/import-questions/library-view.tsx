"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Download, Eye, FilePlus2, FileStack, Pencil, Plus, TableProperties, X } from "lucide-react";
import { IMPORT_METHODS } from "@/components/proto/import-methods";
import { Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TEMPLATE_COLUMNS } from "@/lib/papers/import-template";
import { formatDate } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { createRevisionAction } from "@/server/actions/question-papers";

export interface PaperListRow {
  id: string;
  name: string;
  subject: string | null;
  course: { id: string; code: string; name: string };
  /** In use by an assessment, ready to use, or incomplete (no review or approval exists). */
  usage: "IN_USE" | "READY" | "INCOMPLETE";
  usageLabel: string;
  version: number;
  sourceFileName: string | null;
  questionCount: number;
  sectionCount: number;
  totalMarks: number;
  updatedAt: string;
}

const TEMPLATE_HELP: Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>> = {
  section: "Required. Section the question belongs to",
  section_rule: "ALL, OPTIONAL, ANY_N, EXACTLY_N, UP_TO_N or BEST_N (first row of the section)",
  section_count: "N for the N-rules",
  group: "Same key on several rows = one case study / comprehension",
  group_text: "Case or passage title (first row of the group)",
  passage: "Case / passage text",
  type: "Required. MCQ_SINGLE, MCQ_MULTI, TRUE_FALSE, SHORT_ANSWER, LONG_ANSWER",
  question: "Required. Question text",
  option_a: "Options A–F for objective questions",
  correct: "Letters, e.g. B or A,C — or TRUE / FALSE",
  marks: "Required, ≥ 0",
  negative_marks: "Objective questions only",
  difficulty: "EASY, MEDIUM or HARD",
};

export function LibraryView({ papers, courses }: { papers: PaperListRow[]; courses: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [status, setStatus] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [, startTransition] = useTransition();

  const rows = useMemo(
    () =>
      papers
        .filter((p) => (status ? p.usage === status : true))
        .filter((p) => (course ? p.course.id === course : true))
        .filter((p) => (q.trim() ? `${p.name} ${p.subject ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [papers, status, course, q],
  );
  const pager = usePagination(rows, 10);
  const filtersActive = Boolean(q || course || status);
  const count = (st: PaperListRow["usage"]) => papers.filter((p) => p.usage === st).length;

  function newVersion(p: PaperListRow) {
    startTransition(async () => {
      const result = await createRevisionAction(p.id);
      if (!result.ok) return toast.error("Couldn’t create a new version", result.error);
      toast.success(`Version ${result.data!.version} created`, "The version used by assessments stays unchanged.");
      router.push(`/admin/import-questions/${result.data!.id}/edit`);
    });
  }

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
            <p className="mt-3 flex-1 text-sm text-muted-foreground">{m.key === "excel" ? "Most reliable. Fill in the template (one row per question) and upload it as CSV." : m.key === "word" ? "Word import isn’t supported yet — copy the questions into the template." : "PDF import isn’t supported yet — copy the questions into the template."}</p>
            <Link href={`/admin/import-questions/new?method=${m.key}`} className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4 self-start" })}>
              Import {m.key === "excel" ? "Excel template" : m.key === "word" ? "Word" : "PDF"}
            </Link>
          </div>
        ))}
      </section>

      <div className="mt-3 flex flex-wrap gap-2">
        <a href="/templates/question-paper-template.csv" download className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <Download /> Download template (CSV)
        </a>
        <Button variant="ghost" size="sm" onClick={() => setTemplateOpen(true)}>
          <TableProperties /> View Template Format
        </Button>
        <Link href="/admin/import-questions/new?method=manual" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <FilePlus2 /> Create manually
        </Link>
      </div>

      <Panel className="mt-6" title="Question Paper Library" description={`${papers.length} papers · ${count("READY")} ready · ${count("IN_USE")} in use · ${count("INCOMPLETE")} incomplete`} bodyClassName="p-0">
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_repeat(2,minmax(0,12rem))_auto]">
          <SearchInput value={q} onChange={setQ} placeholder="Search question papers…" />
          <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={courses.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField
            value={status}
            onChange={setStatus}
            placeholder="Any usage"
            ariaLabel="Usage"
            options={(["READY", "IN_USE", "INCOMPLETE"] as const).map((x) => ({ value: x, label: `${x === "IN_USE" ? "In use" : x === "READY" ? "Ready" : "Incomplete"} (${count(x)})` }))}
          />
          {filtersActive ? (
            <Button
              variant="ghost"
              onClick={() => {
                setQ("");
                setCourse("");
                setStatus("");
              }}
            >
              <X /> Clear
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            className="m-4 mt-0"
            icon={FileStack}
            title={papers.length === 0 ? "No question papers yet" : "No question papers match"}
            description={papers.length === 0 ? "Import a paper from the template, or create one manually." : "Adjust the filters."}
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
                  <TableHead className="text-right">Questions</TableHead>
                  <TableHead className="text-right">Sections</TableHead>
                  <TableHead className="text-right">Max Marks</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/admin/import-questions/${p.id}`)}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.sourceFileName ? `Imported from ${p.sourceFileName}` : "Created manually"}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.course.name}</TableCell>
                    <TableCell className="text-muted-foreground">{p.subject ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.questionCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.sectionCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.totalMarks}</TableCell>
                    <TableCell className="text-muted-foreground">v{p.version}</TableCell>
                    <TableCell>
                      <StatusBadge status={p.usageLabel} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(p.updatedAt)}</TableCell>
                    <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <RowActions
                        label={`Actions for ${p.name}`}
                        actions={[
                          { label: "View", icon: Eye, onSelect: () => router.push(`/admin/import-questions/${p.id}`) },
                          ...(p.usage !== "IN_USE" ? [{ label: "Edit", icon: Pencil, onSelect: () => router.push(`/admin/import-questions/${p.id}/edit`) }] : []),
                          ...(p.usage === "IN_USE" ? [{ label: "New version", icon: FilePlus2, onSelect: () => newVersion(p) }] : []),
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

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Question paper template</DialogTitle>
            <DialogDescription>One row per question, saved as CSV (UTF-8). Column names aren’t case-sensitive; only section, type, question and marks are required.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Column</th>
                  <th className="px-3 py-2 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {TEMPLATE_COLUMNS.filter((c) => !/^option_[b-f]$/.test(c)).map((c) => (
                  <tr key={c} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{c === "option_a" ? "option_a … option_f" : c}</td>
                    <td className="px-3 py-2 text-muted-foreground">{TEMPLATE_HELP[c] ?? "Optional"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>
              Close
            </Button>
            <a href="/templates/question-paper-template.csv" download className={buttonVariants()}>
              <Download /> Download template
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
