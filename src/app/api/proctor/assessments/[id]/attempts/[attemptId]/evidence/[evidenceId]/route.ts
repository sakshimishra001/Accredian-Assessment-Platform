import { errorResponse, requireApiUser } from "@/server/files/http";
import { evidenceImage } from "@/server/services/proctoring-evidence";

/*
 * One proctoring evidence image (proctor dashboard, phase 7), for an administrator or a proctor
 * assigned to the assessment — checked on every request (examiners and learners: 403; anything
 * else, including another assessment's or attempt's evidence and guessed ids: 404). Then either a
 * redirect to a signed URL valid for a minute (Supabase Storage) or the image itself. Never cached,
 * never sent as a referrer.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export async function GET(_request: Request, ctx: RouteContext<"/api/proctor/assessments/[id]/attempts/[attemptId]/evidence/[evidenceId]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { id, attemptId, evidenceId } = await ctx.params;
    const image = await evidenceImage(user, id, attemptId, evidenceId);
    if ("url" in image) return new Response(null, { status: 302, headers: { ...NO_STORE, Location: image.url } });
    return new Response(new Uint8Array(image.data), {
      status: 200,
      headers: { ...NO_STORE, "Content-Type": "image/jpeg", "Content-Length": String(image.data.length), "Content-Disposition": "inline", "Cross-Origin-Resource-Policy": "same-origin" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
