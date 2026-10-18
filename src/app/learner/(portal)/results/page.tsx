import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { buttonVariants } from "@/components/ui/button";
import { Role } from "@/lib/auth/rbac";
import { formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listMyResults } from "@/server/services/results";
import { PassBadge, ResultStateNote } from "./result-state";

export const metadata: Metadata = { title: "My Results" };

/** The learner's own attempts across their assessments, each with its result once visible. */
export default async function MyResultsPage() {
  const actor = await requireRole(Role.LEARNER);
  const groups = await listMyResults(actor);
  return (
    <>
      <PageHeader title="My Results" description="Your attempts and, once they are released, your results." />
      {groups.length === 0 ? (
        <EmptyState title="No attempts yet" description="Your result appears here after you submit an assessment." action={<Link href="/learner" className={buttonVariants()}>Go to dashboard</Link>} />
      ) : (
        <div className="grid gap-8">
          {groups.map(({ assessment, attempts }) => (
            <section key={assessment.id} aria-labelledby={`results-${assessment.id}`} className="grid gap-4">
              <h2 id={`results-${assessment.id}`} className="text-base font-semibold">
                {assessment.name}
              </h2>
              {attempts.map((a) => (
                <Panel
                  key={a.attemptId}
                  title={`Attempt #${a.attemptNumber}`}
                  description={a.submittedAt ? `Submitted ${formatDateTime(a.submittedAt.toISOString())} IST` : "In progress"}
                  actions={
                    a.resultState === "AVAILABLE" ? (
                      <Link href={`/learner/results/${a.attemptId}`} className={buttonVariants({ size: "sm" })}>
                        View result
                      </Link>
                    ) : null
                  }
                >
                  {a.result ? (
                    <div className="flex flex-wrap items-center gap-4">
                      <p className="text-2xl font-semibold tabular-nums">
                        {a.result.obtained} <span className="text-base font-normal text-muted-foreground">/ {a.result.maxMarks}</span>
                      </p>
                      <span className="text-sm text-muted-foreground">{a.result.percentage}%</span>
                      <PassBadge passed={a.result.passed} />
                    </div>
                  ) : (
                    <ResultStateNote state={a.resultState} />
                  )}
                </Panel>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
