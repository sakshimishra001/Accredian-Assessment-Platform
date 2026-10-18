import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listMyAssessments } from "@/server/services/learner-home";
import { MyAssessmentCard } from "../my-assessment";

export const metadata: Metadata = { title: "My Assessments" };

/** Every assessment the learner is assigned to (drafts are never shown), from PostgreSQL. */
export default async function LearnerAssessments() {
  const actor = await requireRole(Role.LEARNER);
  const assessments = await listMyAssessments(actor);
  return (
    <>
      <PageHeader title="My Assessments" description="All assessments you are assigned to. Your one learner password signs you in to each of them." />
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
