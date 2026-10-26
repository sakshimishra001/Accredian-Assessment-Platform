import { assertSameOrigin, errorResponse, requireApiUser } from "@/server/files/http";
import { leavePresence, recordPresence } from "@/server/services/presence";

/*
 * Learner presence heartbeat (proctor dashboard, phase 6) for the learner's own running attempt.
 * POST: "still here" (every ~20 s while the exam page is open), with the camera / face / screen
 * state when proctoring evidence is on (phase 7). DELETE: the page is closing.
 * Body: { connectionId, status? } — a random id per exam page. Same-origin only. Presence is
 * connection status, never a proctoring violation; nothing is written to the database.
 */

export const dynamic = "force-dynamic";

async function bodyOf(request: Request): Promise<{ connectionId?: unknown; status?: unknown }> {
  try {
    const body = (await request.json()) as { connectionId?: unknown; status?: unknown } | null;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/presence">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertSameOrigin(request);
    const { attemptId } = await ctx.params;
    const body = await bodyOf(request);
    await recordPresence(user, attemptId, body.connectionId, new Date(), body.status);
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
    await leavePresence(user, attemptId, (await bodyOf(request)).connectionId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
