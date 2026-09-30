"use client";

import { useRouter } from "next/navigation";
import { Activity, BarChart3, CalendarClock, Copy, Eye, Pencil, UserPlus } from "lucide-react";
import { newId, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Assessment } from "@/prototype/types";
import type { RowAction } from "./row-actions";

export const EDITABLE_STATUSES: Assessment["status"][] = ["Draft", "Scheduled"];

export function useAssessmentActions() {
  const router = useRouter();
  const toast = useToast();
  const { saveAssessment } = useProtoActions();

  const duplicate = (a: Assessment) => {
    const copy: Assessment = {
      ...a,
      id: newId("a"),
      name: `${a.name} (Copy)`,
      status: "Draft",
      attempted: 0,
      createdAt: new Date().toISOString(),
    };
    saveAssessment(copy);
    toast.success("Assessment duplicated", `“${copy.name}” was created as a draft.`);
    return copy;
  };

  const rowActions = (a: Assessment): RowAction[] => [
    { label: "View", icon: Eye, onSelect: () => router.push(`/admin/assessments/${a.id}`) },
    {
      label: "Edit",
      icon: Pencil,
      onSelect: () =>
        EDITABLE_STATUSES.includes(a.status)
          ? router.push(`/admin/assessments/new?edit=${a.id}`)
          : toast.error("This assessment can’t be edited", `${a.status} assessments are locked to protect learner attempts.`),
    },
    { label: "Duplicate", icon: Copy, onSelect: () => duplicate(a) },
    {
      label: "Schedule",
      icon: CalendarClock,
      onSelect: () =>
        a.status === "Draft"
          ? router.push(`/admin/assessments/new?edit=${a.id}&step=3`)
          : toast.info(`Already ${a.status.toLowerCase()}`, "Only draft assessments can be scheduled."),
    },
    { label: "Assign", icon: UserPlus, onSelect: () => router.push(`/admin/assessments/${a.id}?tab=examiners`), separatorBefore: true },
    { label: "Monitor", icon: Activity, onSelect: () => router.push(`/admin/assessments/${a.id}?tab=monitor`) },
    { label: "Results", icon: BarChart3, onSelect: () => router.push(`/admin/assessments/${a.id}?tab=results`) },
  ];

  return { rowActions, duplicate };
}
