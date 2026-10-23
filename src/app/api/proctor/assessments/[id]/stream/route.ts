import { readSessionToken } from "@/server/auth/current-user";
import { validateSessionToken } from "@/server/auth/session";
import { errorResponse, requireApiUser } from "@/server/files/http";
import { MAX_SUBSCRIBERS_PER_ASSESSMENT, monitoringBus } from "@/server/realtime/bus";
import { createMonitoringStream, SSE_HEADERS } from "@/server/realtime/sse";
import { authorizeMonitoringStream } from "@/server/services/proctor-monitoring";

/*
 * Live monitoring events for one assessment (proctor dashboard, phase 5), as Server-Sent Events.
 * Authorized exactly like the monitoring pages: an administrator, or an active proctor assigned to
 * the assessment (examiners and learners: 403; an unassigned proctor or unknown assessment: 404). The
 * stream re-checks access every minute and ends itself after a few minutes; the browser reconnects
 * (authorizing afresh). The dashboard also polls, so it keeps working if this is unavailable.
 *
 * Single-server: events reach only connections on the server process that published them (see
 * server/realtime/bus.ts).
 */

export const dynamic = "force-dynamic";
// Hosting platforms with a function time limit (e.g. Vercel) cut the stream there; it ends itself first.
export const maxDuration = 300;

export async function GET(request: Request, ctx: RouteContext<"/api/proctor/assessments/[id]/stream">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { id } = await ctx.params;
    const assessmentId = await authorizeMonitoringStream(user, id);
    if (monitoringBus.subscriberCount(assessmentId) >= MAX_SUBSCRIBERS_PER_ASSESSMENT) {
      return Response.json({ ok: false, error: "Too many live connections; the dashboard will refresh periodically instead." }, { status: 503 });
    }
    // Only the session token (a string) is kept, to re-check access while the stream is open.
    const token = await readSessionToken();
    const userId = user.id;
    const stream = createMonitoringStream({
      assessmentId,
      bus: monitoringBus,
      signal: request.signal,
      recheck: async () => {
        const current = await validateSessionToken(token);
        if (!current || current.id !== userId) return false;
        try {
          await authorizeMonitoringStream(current, assessmentId);
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
