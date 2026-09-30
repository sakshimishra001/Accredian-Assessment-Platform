"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Mail, UserCheck, UserX } from "lucide-react";
import { DetailList, EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime, initials } from "@/prototype/lib/format";
import { useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Evaluation } from "@/prototype/types";

function EvalTable({ rows, empty }: { rows: Evaluation[]; empty: string }) {
  const lookup = useLookups();
  return rows.length === 0 ? (
    <p className="p-4 text-sm text-muted-foreground">{empty}</p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Learner</TableHead>
          <TableHead>Assessment</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="pr-4">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="pl-4 font-medium">{lookup.learner(e.learnerId)?.name}</TableCell>
            <TableCell className="text-muted-foreground">{lookup.assessment(e.assessmentId)?.name}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(e.dueDate)}</TableCell>
            <TableCell className="pr-4">
              <StatusBadge status={e.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function ExaminerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const s = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const { updateExaminer } = useProtoActions();
  const ex = lookup.examiner(id);

  if (!ex) {
    return <EmptyState className="mt-10" title="Examiner not found" action={<Link href="/admin/examiners" className={buttonVariants()}>Back to examiners</Link>} />;
  }

  const assigned = s.assessments.filter((a) => a.examinerIds.includes(id));
  const evs = s.evaluations.filter((e) => e.examinerId === id);
  const pending = evs.filter((e) => e.status !== "Completed");
  const completed = evs.filter((e) => e.status === "Completed");

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Examiners", href: "/admin/examiners" }, { label: ex.name }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar size="lg">
              <AvatarFallback>{initials(ex.name)}</AvatarFallback>
            </Avatar>
            {ex.name}
          </span>
        }
        meta={<StatusBadge status={ex.status} />}
        description={`${ex.specialization} · ${ex.email}`}
        actions={
          <>
            <Button variant="outline" disabled={pending.length === 0} onClick={() => toast.success("Reminder sent", `${ex.name} was reminded about ${pending.length} pending evaluation${pending.length === 1 ? "" : "s"} (simulated).`)}>
              <Mail /> Send reminder
            </Button>
            {ex.status === "Inactive" ? (
              <Button variant="outline" onClick={() => { updateExaminer(ex.id, { status: "Active" }); toast.success(`${ex.name} reactivated`); }}>
                <UserCheck /> Reactivate
              </Button>
            ) : (
              <Button variant="outline" onClick={() => { updateExaminer(ex.id, { status: "Inactive" }); toast.success(`${ex.name} deactivated`, "They won’t receive new scripts."); }}>
                <UserX /> Deactivate
              </Button>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Assigned assessments" value={assigned.length} />
        <MetricCard label="Pending evaluations" value={pending.length} tone="attention" />
        <MetricCard label="Completed evaluations" value={completed.length} />
        <MetricCard label="Avg. turnaround" value={completed.length ? "1.8 days" : "—"} hint="Simulated" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <Panel title="Profile">
          <DetailList
            className="grid-cols-[6.5rem_1fr]"
            items={[
              ["Email", ex.email],
              ["Specialization", ex.specialization],
              ["Status", <StatusBadge key="s" status={ex.status} />],
              ["Portal access", ex.status === "Invited" ? "Invitation pending" : "Examiner portal"],
            ]}
          />
        </Panel>
        <Panel title="Assigned assessments" bodyClassName="p-0">
          {assigned.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Not assigned to any assessment. Assign examiners from an assessment’s Examiners tab.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Assessment</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assigned.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-4">
                      <Link href={`/admin/assessments/${a.id}?tab=examiners`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{lookup.batch(a.batchId)?.label}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(a.schedule.start)}</TableCell>
                    <TableCell className="pr-4">
                      <StatusBadge status={a.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Pending evaluations" bodyClassName="p-0">
          <EvalTable rows={pending} empty="No pending evaluations." />
        </Panel>
        <Panel title="Completed evaluations" bodyClassName="p-0">
          <EvalTable rows={completed} empty="No completed evaluations yet." />
        </Panel>
      </div>
    </>
  );
}
