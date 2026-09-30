import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { DifficultyLabel, DIFFICULTY_LABEL, InactiveBadge, QuestionTypeBadge, VersionTag } from "@/components/admin/badges";
import { EmptyState, PageHeader } from "@/components/shared/app-shell";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Difficulty, QuestionType } from "@/generated/prisma/enums";
import { formatDate } from "@/lib/format";
import { ALL_QUESTION_TYPES, QUESTION_TYPES } from "@/lib/questions/types";
import { requireRole } from "@/server/auth/guards";
import { listQuestions, listTopics, type QuestionStatusFilter } from "@/server/services/questions";

export const metadata: Metadata = { title: "Question bank" };

const STATUS_FILTERS: { value: QuestionStatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Inactive" },
  { value: "all", label: "Active + inactive" },
];

function one(v: string | string[] | undefined) {
  return typeof v === "string" ? v : undefined;
}

export default async function QuestionBankPage({ searchParams }: PageProps<"/admin/questions">) {
  const actor = await requireRole("ADMIN");
  const sp = await searchParams;
  const q = one(sp.q) ?? "";
  const type = ALL_QUESTION_TYPES.includes(one(sp.type) as QuestionType) ? (one(sp.type) as QuestionType) : undefined;
  const difficulty = Object.values(Difficulty).includes(one(sp.difficulty) as Difficulty) ? (one(sp.difficulty) as Difficulty) : undefined;
  const status = (STATUS_FILTERS.find((s) => s.value === one(sp.status))?.value ?? "active") as QuestionStatusFilter;
  const page = Number(one(sp.page)) || 1;
  const topics = await listTopics(actor);
  const topic = topics.find((t) => t === one(sp.topic));

  const { rows, total, pageCount } = await listQuestions(actor, { q, type, difficulty, topic, status, page });
  const filtered = Boolean(q || type || difficulty || topic || status !== "active");

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (difficulty) params.set("difficulty", difficulty);
    if (topic) params.set("topic", topic);
    if (status !== "active") params.set("status", status);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return `/admin/questions${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Question bank" description="Reusable questions for assessments." />
        <Link href="/admin/questions/new" className={buttonVariants()}>
          <Plus /> New question
        </Link>
      </div>

      <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Search text or topic…" className="w-64" aria-label="Search questions" />
        <NativeSelect name="type" defaultValue={type ?? ""} aria-label="Question type">
          <NativeSelectOption value="">All types</NativeSelectOption>
          {ALL_QUESTION_TYPES.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {QUESTION_TYPES[t].label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect name="difficulty" defaultValue={difficulty ?? ""} aria-label="Difficulty">
          <NativeSelectOption value="">Any difficulty</NativeSelectOption>
          {Object.values(Difficulty).map((d) => (
            <NativeSelectOption key={d} value={d}>
              {DIFFICULTY_LABEL[d]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect name="topic" defaultValue={topic ?? ""} aria-label="Topic">
          <NativeSelectOption value="">All topics</NativeSelectOption>
          {topics.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {t}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect name="status" defaultValue={status} aria-label="Status">
          {STATUS_FILTERS.map((s) => (
            <NativeSelectOption key={s.value} value={s.value}>
              {s.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <button type="submit" className={buttonVariants({ variant: "secondary" })}>
          Apply
        </button>
        {filtered ? (
          <Link href="/admin/questions" className={buttonVariants({ variant: "ghost" })}>
            Clear
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No questions match these filters" : "No questions yet"}
          description="Create a question to start building your bank."
        />
      ) : (
        <div className="rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[45%]">Question</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Difficulty</TableHead>
                <TableHead className="text-right">Marks</TableHead>
                <TableHead className="text-right">Used in</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-0 whitespace-normal">
                    <Link href={`/admin/questions/${r.id}`} className="line-clamp-2 font-medium hover:underline">
                      {r.text}
                    </Link>
                    <div className="mt-1 flex items-center gap-2">
                      <VersionTag version={r.version} />
                      {r.isArchived ? <InactiveBadge /> : null}
                    </div>
                  </TableCell>
                  <TableCell><QuestionTypeBadge type={r.type} /></TableCell>
                  <TableCell className="text-muted-foreground">{r.topic ?? "—"}</TableCell>
                  <TableCell><DifficultyLabel difficulty={r.difficulty} /></TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.marks}
                    {r.negativeMarks > 0 ? <span className="text-destructive"> / −{r.negativeMarks}</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.usageCount}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(r.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total} question{total === 1 ? "" : "s"}
        </span>
        {pageCount > 1 ? (
          <span className="flex items-center gap-2">
            {page > 1 ? <Link className="hover:underline" href={pageHref(page - 1)}>Previous</Link> : null}
            <span>
              Page {page} of {pageCount}
            </span>
            {page < pageCount ? <Link className="hover:underline" href={pageHref(page + 1)}>Next</Link> : null}
          </span>
        ) : null}
      </div>
    </>
  );
}
