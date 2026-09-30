import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { proxy } from "@/proxy";

function request(path: string, cookie?: string) {
  const req = new NextRequest(new URL(path, "http://localhost:3000"));
  if (cookie) req.cookies.set(SESSION_COOKIE_NAME, cookie);
  return req;
}

describe("proxy", () => {
  it("redirects requests without a session cookie to /login with next param", () => {
    const res = proxy(request("/admin/users?page=2"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/admin/users?page=2");
  });

  it("lets requests with a session cookie through (roles are checked on the page)", () => {
    const res = proxy(request("/learner", "some-token"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
