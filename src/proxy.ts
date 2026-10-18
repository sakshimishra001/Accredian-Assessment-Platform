import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { isProtectedPath, loginPathFor } from "@/lib/auth/rbac";
import { allowsWasm, contentSecurityPolicy, newNonce } from "@/lib/security/csp";

/**
 * Runs before every page request.
 *
 * 1. Optimistic auth check only: requests to a protected area without a session cookie go to
 *    the sign-in page (/learner/login for the learner area, /login for staff) before anything renders. It deliberately does not touch the database. Session
 *    validity and the role check happen server-side in requireRole(), called by each page.
 * 2. Content-Security-Policy with a per-request nonce. Next.js reads the nonce from the request's
 *    CSP header and adds it to its own scripts (pages are rendered dynamically for this). Only the
 *    learner's exam pages may also compile WebAssembly (in-browser face detection).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isProtectedPath(pathname) && !request.cookies.has(SESSION_COOKIE_NAME)) {
    const loginUrl = new URL(loginPathFor(pathname), request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  const csp = contentSecurityPolicy({
    nonce: newNonce(),
    dev: process.env.NODE_ENV === "development",
    upgradeInsecure: (process.env.APP_URL ?? "").startsWith("https://"),
    wasm: allowsWasm(pathname),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Every page; not API routes (they set their own headers), build assets or public files.
      source: "/((?!api/|_next/static|_next/image|favicon.ico|templates/|vendor/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
