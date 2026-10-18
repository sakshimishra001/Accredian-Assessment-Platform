import { revalidatePath } from "next/cache";
import { MAX_MATERIAL_MB } from "@/lib/files/types";
import { assertSameOrigin, errorResponse, readUpload, requireApiUser } from "@/server/files/http";
import { addMaterial, assertCanUpload } from "@/server/services/files";

/**
 * Admin: attach a supporting material to a question of a draft paper (multipart: file,
 * paperQuestionId, description). Same-origin only; the body is capped before it is parsed.
 */
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    assertCanUpload(user, "material");
    assertSameOrigin(request);
    const { upload, field } = await readUpload(request, MAX_MATERIAL_MB * 1024 * 1024);
    const material = await addMaterial(user, field("paperQuestionId") ?? "", upload, field("description"));
    revalidatePath("/admin/import-questions", "layout");
    return Response.json({ ok: true, data: material });
  } catch (err) {
    return errorResponse(err);
  }
}
