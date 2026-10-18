import { errorResponse, requireApiUser } from "@/server/files/http";
import { reportResponse } from "@/server/reports/http";
import { assessmentResultsCsv } from "@/server/services/reports";

/** GET /api/reports/assessments/:id/results — every candidate's results as CSV (admins only). */
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/assessments/[id]/results">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { id } = await ctx.params;
    return reportResponse(await assessmentResultsCsv(user, id));
  } catch (err) {
    return errorResponse(err);
  }
}
