import { errorResponse, requireApiUser } from "@/server/files/http";
import { getProctorViolationAlert } from "@/server/services/proctor-monitoring";

/**
 * One counted violation's details for the proctor's live alert (learner name, type, time, count) —
 * the live event carries only its id. An administrator or a proctor assigned to the assessment;
 * anything else is refused or "not found".
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/proctor/assessments/[id]/attempts/[attemptId]/violations/[eventId]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { id, attemptId, eventId } = await ctx.params;
    const v = await getProctorViolationAlert(user, id, attemptId, eventId);
    return Response.json({ ok: true, data: { ...v, at: v.at.toISOString() } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
