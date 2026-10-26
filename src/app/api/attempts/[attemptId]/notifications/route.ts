import { errorResponse, requireApiUser } from "@/server/files/http";
import { listMyUnreadNotifications } from "@/server/services/proctor-notifications";

/*
 * Learner: the unread proctor notifications of their own attempt (proctor dashboard, phase 8), oldest
 * first — the text and time only. Polled by the exam page as a fallback to the notification stream,
 * and loaded when the exam opens. Any attempt that isn't the learner's own is "not found".
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/notifications">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { attemptId } = await ctx.params;
    return Response.json({ ok: true, data: await listMyUnreadNotifications(user, attemptId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
