import type { Metadata } from "next";
import { EmptyState, MetricCard, PageHeader } from "@/components/proto/page";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listMyAssessments } from "@/server/services/learner-home";
import { learnerState, MyAssessmentCard } from "./my-assessment";

export const metadata: Metadata = { title: "Dashboard" };

/** Learner home: every assessment the learner is assigned to, with where they stand on each. */
export default async function LearnerDashboard() {
  const actor = await requireRole(Role.LEARNER);
  const assessments = await listMyAssessments(actor);
  const states = assessments.map(learnerState);
  const count = (...s: (typeof states)[number][]) => states.filter((x) => s.includes(x)).length;
  return (
    <>
      <PageHeader title={`Welcome, ${actor.name.split(" ")[0]}`} description="Your assessments: upcoming, active and completed." />
      <div className="mb-8 grid grid-cols-3 gap-3 md:max-w-xl">
        <MetricCard label="Active" value={count("open", "in_progress")} />
        <MetricCard label="Upcoming" value={count("upcoming")} />
        <MetricCard label="Completed" value={count("completed")} />
      </div>
      {assessments.length === 0 ? (
        <EmptyState title="No assessments yet" description="Assessments you are assigned to will appear here." />
      ) : (
        <div className="grid gap-4">
          {assessments.map((o) => (
            <MyAssessmentCard key={o.assessment.id} overview={o} />
          ))}
        </div>
      )}
    </>
  );
}
