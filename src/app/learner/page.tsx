"use client";

import { LearnerSection } from "@/components/proto/learner-cards";
import { useLearnerAssessments } from "@/components/proto/learner-data";
import { MetricCard, PageHeader } from "@/components/proto/page";
import { useLookups } from "@/prototype/store";

export default function LearnerDashboard() {
  const { me, active, upcoming, completed } = useLearnerAssessments();
  const lookup = useLookups();
  return (
    <>
      <PageHeader title={`Welcome, ${me.name.split(" ")[0]}`} description={`${lookup.batch(me.batchId)?.name} · your assessments at a glance`} />
      <div className="mb-8 grid grid-cols-3 gap-3 md:max-w-xl">
        <MetricCard label="Active" value={active.length} />
        <MetricCard label="Upcoming" value={upcoming.length} />
        <MetricCard label="Completed" value={completed.length} />
      </div>
      <LearnerSection title="Active Assessments" items={active} kind="active" empty="No assessments are open right now." />
      <LearnerSection title="Upcoming Assessments" items={upcoming} kind="upcoming" empty="Nothing scheduled yet." />
      <LearnerSection title="Completed Assessments" items={completed} kind="completed" empty="You haven’t completed any assessments yet." />
    </>
  );
}
