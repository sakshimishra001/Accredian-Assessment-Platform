import { readSessionToken } from "@/server/auth/current-user";
import { validateSessionToken } from "@/server/auth/session";
import { errorResponse, requireApiUser } from "@/server/files/http";
import { learnerNotificationBus, MAX_LEARNER_STREAMS_PER_ATTEMPT } from "@/server/realtime/bus";
import { createMonitoringStream, SSE_HEADERS } from "@/server/realtime/sse";
import { authorizeMyNotificationStream } from "@/server/services/proctor-notifications";

/*
 * The learner's proctor-notification stream (proctor dashboard, phase 8), as Server-Sent Events —
 * the same stream as the proctor dashboard's, on a bus keyed by attempt that carries only this
 * attempt's PROCTOR_NOTIFICATION events (identifiers only; the page then fetches the text). Only the
 * attempt's own learner, while it is in progress; access is re-checked every minute and the stream
 * ends itself after a few minutes (the browser reconnects). The exam never depends on it: it also
 * polls, and a failed stream changes nothing about the attempt.
 *
 * Single-server: a notification reaches only streams on the server process that stored it; polling
 * covers the rest.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/notifications/stream">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { attemptId: raw } = await ctx.params;
    const { attemptId, assessmentId } = await authorizeMyNotificationStream(user, raw);
    if (learnerNotificationBus.subscriberCount(attemptId) >= MAX_LEARNER_STREAMS_PER_ATTEMPT) {
      return Response.json({ ok: false, error: "Too many open exam pages; notifications are checked periodically instead." }, { status: 503 });
    }
    // Only the session token (a string) is kept, to re-check access while the stream is open.
    const token = await readSessionToken();
    const userId = user.id;
    const stream = createMonitoringStream({
      assessmentId,
      topic: attemptId,
      bus: learnerNotificationBus,
      signal: request.signal,
      recheck: async () => {
        const current = await validateSessionToken(token);
        if (!current || current.id !== userId) return false;
        try {
          await authorizeMyNotificationStream(current, attemptId);
          return true;
        } catch {
          return false;
        }
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (err) {
    return errorResponse(err);
  }
}
