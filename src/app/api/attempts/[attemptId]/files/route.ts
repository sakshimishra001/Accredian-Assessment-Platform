import { MAX_ANSWER_MB } from "@/lib/files/types";
import { assertSameOrigin, errorResponse, readUpload, requireApiUser } from "@/server/files/http";
import { assertCanUpload, uploadAnswerFile } from "@/server/services/files";

/**
 * Learner: upload (or replace) a file for an answer in their own open attempt
 * (multipart: file, assessmentQuestionId, replaceAttachmentId?). Same-origin only; the body is
 * capped at the platform's largest answer size before parsing — the question's own (smaller)
 * limit, type rules, ownership and timing are checked by the service.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/attempts/[attemptId]/files">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertCanUpload(user, "answer");
    assertSameOrigin(request);
    const { attemptId } = await ctx.params;
    const { upload, field } = await readUpload(request, MAX_ANSWER_MB * 1024 * 1024);
    const result = await uploadAnswerFile(user, attemptId, field("assessmentQuestionId") ?? "", upload, { replaceAttachmentId: field("replaceAttachmentId") });
    return Response.json({ ok: true, data: result });
  } catch (err) {
    return errorResponse(err);
  }
}
