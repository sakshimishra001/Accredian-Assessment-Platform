"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { List, Mail, Plus, Upload, UserCheck, UserX, Users } from "lucide-react";
import { Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { ImportLearnersDialog, makeLearners } from "@/components/proto/import-learners-dialog";
import { EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime, formatNumber } from "@/prototype/lib/format";
import { newId, useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

export default function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const s = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const { addLearners, updateLearner } = useProtoActions();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const batch = lookup.batch(id);

  const learners = useMemo(
    () =>
      s.learners
        .filter((l) => l.batchId === id)
        .filter((l) => (status ? l.status === status : true))
        .filter((l) => (q.trim() ? `${l.name} ${l.email}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [s.learners, id, status, q],
  );
  const pager = usePagination(learners, 12);

  if (!batch) {
    return <EmptyState className="mt-10" title="Batch not found" action={<Link href="/admin/batches" className={buttonVariants()}>Back to batches</Link>} />;
  }

  const all = s.learners.filter((l) => l.batchId === id);
  const assessments = s.assessments.filter((a) => a.batchId === id).sort((a, b) => b.schedule.start.localeCompare(a.schedule.start));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Batches & Learners", href: "/admin/batches" }, { label: batch.label }]}
        title={batch.name}
        meta={<StatusBadge status={batch.status} />}
        description={`${lookup.course(batch.courseId)?.name} · created ${formatDate(batch.createdAt)}`}
        actions={
          <>
            <Button variant="outline" onClick={() => tableRef.current?.scrollIntoView({ behavior: "smooth" })}>
              <List /> View Learners
            </Button>
            <Button onClick={() => setImportOpen(true)}>
              <Upload /> Import Learners
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Learners" value={formatNumber(all.length)} />
        <MetricCard label="Active" value={formatNumber(all.filter((l) => l.status === "Active").length)} />
        <MetricCard label="Invited" value={formatNumber(all.filter((l) => l.status === "Invited").length)} tone="attention" />
        <MetricCard label="Assessments" value={assessments.length} />
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
        {assessments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assessments assigned yet.</p>
        ) : (
          <ul className="divide-y">
            {assessments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <Link href={`/admin/assessments/${a.id}`} className="block truncate text-sm font-medium hover:underline">
                    {a.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">{formatDateTime(a.schedule.start)} IST</span>
                </span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div ref={tableRef} className="scroll-mt-20">
        <Panel title="Learners" description={`${formatNumber(learners.length)} shown`} bodyClassName="p-0">
          <div className="grid gap-2 p-4 sm:grid-cols-[1fr_10rem]">
            <SearchInput value={q} onChange={setQ} placeholder="Search by name or email…" />
            <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Learner status" options={["Active", "Invited", "Inactive"].map((x) => ({ value: x, label: x }))} />
          </div>
          {learners.length === 0 ? (
            <EmptyState className="m-4 mt-0" icon={Users} title="No learners match" />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
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
                      <TableCell className="pr-4 text-right">
                        <RowActions
                          label={`Actions for ${l.name}`}
                          actions={[
                            { label: "Resend invite", icon: Mail, onSelect: () => toast.success("Invitation resent", `${l.email} (simulated).`), disabled: l.status !== "Invited" },
                            l.status === "Inactive"
                              ? { label: "Reactivate", icon: UserCheck, onSelect: () => { updateLearner(l.id, { status: "Active" }); toast.success(`${l.name} reactivated`); } }
                              : { label: "Deactivate", icon: UserX, destructive: true, onSelect: () => { updateLearner(l.id, { status: "Inactive" }); toast.success(`${l.name} deactivated`, "They can no longer start assessments."); } },
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

      <ImportLearnersDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        batchName={batch.label}
        onImport={(mode, single) => {
          const list = mode === "csv" ? makeLearners(batch.id, 12, all.length) : [{ id: newId("l"), name: single!.name, email: single!.email, batchId: batch.id, status: "Invited" as const }];
          addLearners(batch.id, list);
          toast.success(`${list.length} learner${list.length === 1 ? "" : "s"} added`, "Invitations queued (simulated).");
        }}
      />
    </>
  );
}
