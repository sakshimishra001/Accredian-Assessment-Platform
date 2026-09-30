"use client";

import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ClipboardList, Copy, Eye, Pencil } from "lucide-react";
import { mapQuestions } from "@/prototype/lib/paper";
import { newId, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { QuestionPaper } from "@/prototype/types";
import type { RowAction } from "./row-actions";

export function usePaperActions() {
  const router = useRouter();
  const toast = useToast();
  const { savePaper, updatePaper } = useProtoActions();
  const { assessments } = useProto();

  const duplicate = (p: QuestionPaper) => {
    const id = newId("p");
    const copy: QuestionPaper = {
      ...p,
      id,
      name: `${p.name} (Copy)`,
      status: "Draft",
      version: "v1.0",
      importedOn: new Date().toISOString(),
      source: "Manual",
      sections: p.sections.map((s) => ({ ...s, id: `${id}-${s.id}` })),
      questions: mapQuestions(p.questions, (q) => ({ ...q, id: `${id}-${q.id}`, sectionId: `${id}-${q.sectionId}` })),
    };
    savePaper(copy);
    toast.success("Question paper duplicated", `“${copy.name}” was created as a draft.`);
    return copy;
  };

  const archive = (p: QuestionPaper) => {
    const inUse = assessments.filter((a) => a.paperId === p.id && ["Scheduled", "Active"].includes(a.status)).length;
    if (inUse) {
      toast.error("Can’t archive this paper", `It is used by ${inUse} scheduled or active assessment${inUse === 1 ? "" : "s"}.`);
      return;
    }
    updatePaper(p.id, { status: "Archived" });
    toast.success("Question paper archived", "It no longer appears when creating assessments.");
  };

  const restore = (p: QuestionPaper) => {
    updatePaper(p.id, { status: "Draft" });
    toast.success("Question paper restored as draft", "Review and approve it again before use.");
  };

  const createAssessment = (p: QuestionPaper) => {
    if (p.status !== "Approved") {
      toast.error("Approve the paper first", "Only approved question papers can be used in assessments.");
      return;
    }
    router.push(`/admin/assessments/new?paper=${p.id}`);
  };

  const rowActions = (p: QuestionPaper): RowAction[] => [
    { label: "View", icon: Eye, onSelect: () => router.push(`/admin/import-questions/${p.id}`) },
    {
      label: "Edit",
      icon: Pencil,
      onSelect: () =>
        p.status === "Processing"
          ? toast.info("Still processing", "This paper will be editable once parsing completes.")
          : p.status === "Archived"
            ? toast.info("Restore the paper to edit it")
            : router.push(`/admin/import-questions/new?paper=${p.id}&step=1`),
    },
    { label: "Duplicate", icon: Copy, onSelect: () => duplicate(p) },
    p.status === "Archived"
      ? { label: "Restore", icon: ArchiveRestore, onSelect: () => restore(p) }
      : { label: "Archive", icon: Archive, onSelect: () => archive(p), destructive: true },
    { label: "Create Assessment", icon: ClipboardList, onSelect: () => createAssessment(p), separatorBefore: true },
  ];

  return { rowActions, duplicate, archive, restore, createAssessment };
}
