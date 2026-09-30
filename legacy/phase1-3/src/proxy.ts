import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";

/**
 * Optimistic check only: bounce requests without a session cookie to /login before rendering.
 * Session validity and role checks happen server-side in requireRole() on each page/action.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE_NAME)) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Keep in sync with PROTECTED_ROUTES in src/lib/auth/rbac.ts (matchers must be static).
  matcher: ["/admin/:path*", "/learner/:path*", "/examiner/:path*"],
};
