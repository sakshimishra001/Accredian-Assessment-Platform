import { getRequestMeta } from "@/server/auth/current-user";
import { errorResponse, fileResponse, requireApiUser } from "@/server/files/http";
import { readFile } from "@/server/services/files";

/** Download or preview a stored file. The file service checks the user may read it (else 404). */
export async function GET(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { id } = await ctx.params;
    const { file, data } = await readFile(user, id, await getRequestMeta());
    return fileResponse(file, data, new URL(request.url).searchParams.get("inline") === "1");
  } catch (err) {
    return errorResponse(err);
  }
}
