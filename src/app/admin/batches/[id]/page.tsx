import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { learnerStatus, toBatchRow } from "@/lib/academic/view";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getBatch } from "@/server/services/batches";
import { BatchDetailView } from "./batch-detail-view";

export const metadata: Metadata = { title: "Batch" };

/** One batch with its course and learners, from PostgreSQL (admin only). */
export default async function BatchDetailPage({ params }: PageProps<"/admin/batches/[id]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  const batch = await getBatch(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <BatchDetailView
      batch={toBatchRow({ ...batch, learnerCount: batch.learners.length })}
      learners={batch.learners.map((l) => ({ id: l.id, name: l.name, email: l.email, status: learnerStatus(l.status), addedAt: l.addedAt.toISOString() }))}
    />
  );
}
