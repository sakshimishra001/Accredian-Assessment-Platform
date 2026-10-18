import type { Metadata } from "next";
import { ClipboardCheck } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Home" };

/** Proctor home. Question papers no longer go through review, so there is no queue here. */
export default async function ReviewerHome() {
  await requireRole(Role.REVIEWER);
  return (
    <>
      <PageHeader title="Home" />
      <EmptyState icon={<ClipboardCheck />} title="Nothing to review" description="Question papers no longer need a proctor’s review or approval — admins use them as soon as they are saved." />
    </>
  );
}
