import { assertSameOrigin, errorResponse, requireApiUser } from "@/server/files/http";
import { markNotificationRead } from "@/server/services/proctor-notifications";

/**
 * Learner: "Got it" — mark one proctor notification of their own attempt read (idempotent).
 * Same-origin only. It changes nothing about the attempt.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/notifications/[notificationId]/read">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertSameOrigin(request);
    const { attemptId, notificationId } = await ctx.params;
    await markNotificationRead(user, attemptId, notificationId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
