"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Download, Mail } from "lucide-react";
import { DetailList, EmptyState, MetricCard, PageHeader, Panel, PrototypeNote } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatDateTime, formatDuration, percent } from "@/prototype/lib/format";
import { seeded } from "@/prototype/lib/random";
import { useLookups, useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

export default function ResultDetailPage() {
  const { id } = useParams<{ id: string }>();
  const s = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const r = s.results.find((x) => x.id === id);

  if (!r) {
    return <EmptyState className="mt-10" title="Result not found" action={<Link href="/admin/results" className={buttonVariants()}>Back to results</Link>} />;
  }

  const a = lookup.assessment(r.assessmentId)!;
  const learner = lookup.learner(r.learnerId)!;
  const paper = lookup.paper(a.paperId)!;
  const rand = seeded(r.id);
  // Split the (mock) total across sections proportionally, with some variation.
  const ratio = r.score !== null ? r.score / r.max : 0;
  const sections = paper.sections.map((sec) => {
    const got = r.score === null ? null : Math.min(sec.marks, Math.round(sec.marks * Math.min(1, Math.max(0, ratio + (rand() - 0.5) * 0.3)) * 2) / 2);
    return { sec, got };
  });

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Results & Reports", href: "/admin/results" }, { label: learner.name }]}
        title={learner.name}
        meta={<StatusBadge status={r.status} />}
        description={`${a.name} · ${lookup.batch(a.batchId)?.label}`}
        actions={
          <>
            <Button variant="outline" onClick={() => toast.success("Scorecard downloaded", `${learner.name.replace(" ", "_")}_scorecard.pdf (simulated).`)}>
              <Download /> Download scorecard
            </Button>
            <Button variant="outline" onClick={() => toast.success("Result emailed", `${learner.email} (simulated).`)}>
              <Mail /> Email learner
            </Button>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Score" value={r.score === null ? "Pending" : `${r.score} / ${r.max}`} />
        <MetricCard label="Percentage" value={r.score === null ? "—" : `${percent(r.score, r.max)}%`} />
        <MetricCard label="Time taken" value={r.timeTakenMinutes ? formatDuration(r.timeTakenMinutes) : "—"} hint={`of ${formatDuration(a.durationMinutes)}`} />
        <MetricCard label="Submitted" value={r.submittedAt ? formatDateTime(r.submittedAt) : "—"} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Panel title="Section-wise score">
          <ul className="grid gap-4">
            {sections.map(({ sec, got }) => (
              <li key={sec.id}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{sec.name}</span>
                  <span className="tabular-nums">{got === null ? "Pending evaluation" : `${got} / ${sec.marks}`}</span>
                </div>
                <Progress value={got === null ? 0 : percent(got, sec.marks)} />
              </li>
            ))}
          </ul>
          <PrototypeNote className="mt-4">Prototype — section scores are simulated from the total.</PrototypeNote>
        </Panel>
        <Panel title="Details">
          <DetailList
            className="grid-cols-[6rem_1fr]"
            items={[
              ["Learner", learner.email],
              ["Assessment", <Link key="a" href={`/admin/assessments/${a.id}`} className="text-primary hover:underline">{a.name}</Link>],
              ["Paper", paper.name],
              ["Attempt", "1 of " + a.maxAttempts],
              ["Negative marking", a.negativeMarking ? `−${a.negativeMarks}` : "No"],
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
