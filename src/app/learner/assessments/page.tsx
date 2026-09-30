"use client";

import { useState } from "react";
import { cn } from "cn";
import { LearnerSection } from "@/components/proto/learner-cards";
import { useLearnerAssessments } from "@/components/proto/learner-data";
import { PageHeader } from "@/components/proto/page";

const TABS = ["Active", "Upcoming", "Completed"] as const;

export default function LearnerAssessments() {
  const { active, upcoming, completed } = useLearnerAssessments();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Active");
  const map = { Active: active, Upcoming: upcoming, Completed: completed };
  return (
    <>
      <PageHeader title="My Assessments" description="Everything assigned to your batch." />
      <div className="mb-6 flex gap-1 border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t} ({map[t].length})
          </button>
        ))}
      </div>
      <LearnerSection
        title={`${tab} assessments`}
        items={map[tab]}
        kind={tab === "Active" ? "active" : tab === "Upcoming" ? "upcoming" : "completed"}
        empty={tab === "Active" ? "No assessments are open right now." : tab === "Upcoming" ? "Nothing scheduled yet." : "No completed assessments."}
      />
    </>
  );
}
