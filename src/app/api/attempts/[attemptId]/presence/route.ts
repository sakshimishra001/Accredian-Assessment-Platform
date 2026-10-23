import { assertSameOrigin, errorResponse, requireApiUser } from "@/server/files/http";
import { leavePresence, recordPresence } from "@/server/services/presence";

/*
 * Learner presence heartbeat (proctor dashboard, phase 6) for the learner's own running attempt.
 * POST: "still here" (every ~20 s while the exam page is open). DELETE: the page is closing.
 * Body: { connectionId } — a random id per exam page. Same-origin only. Presence is connection
 * status, never a proctoring violation; nothing is written to the database.
 */

export const dynamic = "force-dynamic";

async function connectionIdFrom(request: Request) {
  try {
    const body = (await request.json()) as { connectionId?: unknown } | null;
    return body?.connectionId;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/presence">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertSameOrigin(request);
    const { attemptId } = await ctx.params;
    await recordPresence(user, attemptId, await connectionIdFrom(request));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/presence">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertSameOrigin(request);
    const { attemptId } = await ctx.params;
    await leavePresence(user, attemptId, await connectionIdFrom(request));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
