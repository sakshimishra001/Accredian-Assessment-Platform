import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { PROTECTED_ROUTES } from "@/lib/auth/rbac";
import { config, proxy } from "@/proxy";

function request(path: string, cookie?: string) {
  const req = new NextRequest(new URL(path, "http://localhost:3000"));
  if (cookie) req.cookies.set(SESSION_COOKIE_NAME, cookie);
  return req;
}

describe("proxy", () => {
  it.each(["/admin", "/examiner/evaluations", "/reviewer/papers/p1"])("redirects %s without a session cookie to /login", (path) => {
    const res = proxy(request(path));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(path);
  });

  it.each(["/learner", "/learner/assessment/a1"])("redirects %s without a session cookie to the learner sign-in", (path) => {
    const res = proxy(request(path));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/learner/login");
    expect(location.searchParams.get("next")).toBe(path);
  });

  it("lets anyone open the learner sign-in page", () => {
    expect(proxy(request("/learner/login")).headers.get("location")).toBeNull();
  });

  it("keeps the query string in the next param", () => {
    const res = proxy(request("/admin/users?page=2"));
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/admin/users?page=2");
  });

  it("lets requests with a session cookie through (session and role are checked server-side)", () => {
    const res = proxy(request("/learner", "some-token"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("never redirects public paths", () => {
    for (const path of ["/", "/login", "/forbidden", "/landing"]) {
      expect(proxy(request(path)).headers.get("location")).toBeNull();
    }
  });

  it("runs for every page (incl. each protected area) but not API routes, build assets or public files", () => {
    const matches = (path: string) => config.matcher.some((m) => new RegExp("^" + m.source + "$").test(path));
    for (const r of PROTECTED_ROUTES) {
      expect(matches(r.prefix)).toBe(true);
      expect(matches(r.prefix + "/anything")).toBe(true);
    }
    for (const path of ["/", "/login", "/forbidden"]) expect(matches(path)).toBe(true);
    for (const path of ["/api/files/x", "/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/templates/question-paper-template.csv"]) {
      expect(matches(path)).toBe(false);
    }
  });

  it("sets a nonce-based Content-Security-Policy on page responses and passes it to rendering", () => {
    const res = proxy(request("/login"));
    const csp = res.headers.get("content-security-policy")!;
    expect(/'nonce-([^']+)'/.exec(csp)?.[1]).toBeTruthy();
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    // The same policy is handed to Next.js on the request so it can apply the nonce.
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    // A fresh nonce per request.
    expect(proxy(request("/login")).headers.get("content-security-policy")).not.toBe(csp);
  });

  const scriptSrc = (path: string) => /script-src [^;]*/.exec(proxy(request(path, "some-token")).headers.get("content-security-policy")!)![0];

  it("allows compiling WebAssembly (face detection) on the learner's exam pages only — never JavaScript eval", () => {
    for (const path of ["/learner/assessment/a1", "/learner/assessment/a1?x=1"]) {
      const src = scriptSrc(path);
      expect(src).toContain("'wasm-unsafe-eval'");
      expect(src).not.toMatch(/'unsafe-eval'/);
      expect(src).toContain("'strict-dynamic'");
    }
    for (const path of ["/learner", "/learner/login", "/learner/results", "/learner/assessments", "/admin", "/admin/assessments/new", "/examiner", "/login", "/"]) {
      expect(scriptSrc(path), path).not.toContain("wasm-unsafe-eval");
    }
  });

  it("serves the self-hosted face-detection assets without per-request page handling", () => {
    const source = (config.matcher as { source: string }[])[0].source;
    const matches = (p: string) => new RegExp(`^${source}$`).test(p);
    expect(matches("/vendor/mediapipe/1.0.1/wasm/vision_wasm_internal.wasm")).toBe(false);
    expect(matches("/learner/assessment/a1")).toBe(true);
  });
});
