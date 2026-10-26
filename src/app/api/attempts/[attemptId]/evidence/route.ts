import { EVIDENCE_MAX_BYTES } from "@/lib/proctoring/evidence";
import { assertSameOrigin, errorResponse, readUpload, requireApiUser } from "@/server/files/http";
import { uploadEvidence } from "@/server/services/proctoring-evidence";

/**
 * Learner: one proctoring evidence snapshot (proctor dashboard, phase 7) for their own running
 * attempt — multipart: file (a JPEG), type (CAMERA | SCREEN). Same-origin only; the body is capped
 * before parsing. Ownership, the attempt running, the assessment's settings and the rate limit are
 * checked by the service. The response says nothing about where the image is stored.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/evidence">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertSameOrigin(request);
    const { attemptId } = await ctx.params;
    const { upload, field } = await readUpload(request, EVIDENCE_MAX_BYTES);
    const evidence = await uploadEvidence(user, attemptId, field("type"), upload.data);
    return Response.json({ ok: true, data: { id: evidence.id, type: evidence.type, capturedAt: evidence.capturedAt } });
  } catch (err) {
    return errorResponse(err);
  }
}
