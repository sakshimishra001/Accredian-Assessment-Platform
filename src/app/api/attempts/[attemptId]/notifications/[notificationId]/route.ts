import { errorResponse, requireApiUser } from "@/server/files/http";
import { getMyNotification } from "@/server/services/proctor-notifications";

/**
 * Learner: one proctor notification of their own attempt — what the notification stream announced
 * (the stream carries identifiers only). Anything else is "not found".
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/notifications/[notificationId]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { attemptId, notificationId } = await ctx.params;
    return Response.json({ ok: true, data: await getMyNotification(user, attemptId, notificationId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
