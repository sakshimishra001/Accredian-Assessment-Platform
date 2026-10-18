import { NotFoundError } from "@/lib/errors";
import { errorResponse, requireApiUser } from "@/server/files/http";
import { reportResponse } from "@/server/reports/http";
import { attemptReport } from "@/server/services/reports";

/**
 * GET /api/reports/attempts/:attemptId/result | evaluation — a candidate result or detailed
 * evaluation PDF. The report service checks the user may see this attempt (admin, or the examiner
 * the candidate is assigned to); anything else is refused or "not found".
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/attempts/[attemptId]/[kind]">) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { attemptId, kind } = await ctx.params;
    if (kind !== "result" && kind !== "evaluation") throw new NotFoundError("Report not found.");
    return reportResponse(await attemptReport(user, attemptId, kind));
  } catch (err) {
    return errorResponse(err);
  }
}
