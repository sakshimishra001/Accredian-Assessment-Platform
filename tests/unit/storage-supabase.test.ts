import { describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env";
import { newStorageKey, SupabaseStorage } from "@/server/storage";

/*
 * The Supabase Storage driver (production file storage), against a stand-in for the Storage API:
 * no request leaves this process. And the settings it needs.
 */

const URL_ = "https://example-project.supabase.co";
const KEY = "service-role-key-for-tests";

type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A fake fetch that records each request and answers with `respond`. */
function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input), headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("SupabaseStorage", () => {
  const key = newStorageKey("answer", "pdf", new Date("2026-10-18T00:00:00Z"));

  it("uploads to the private bucket with the service-role key, never overwriting", async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ Key: `assessment-files/${key}`, Id: "x" }));
    await new SupabaseStorage({ url: `${URL_}/`, serviceRoleKey: KEY, bucket: "assessment-files", fetch: fetchFn }).put(key, Buffer.from("%PDF-1.7 test"));
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${URL_}/storage/v1/object/assessment-files/${key}`);
    expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(c.headers.get("apikey")).toBe(KEY);
    expect(c.headers.get("x-upsert")).toBe("false");
  });

  it("downloads the bytes back", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const { calls, fetchFn } = fakeFetch(() => new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    const got = await new SupabaseStorage({ url: URL_, serviceRoleKey: KEY, bucket: "assessment-files", fetch: fetchFn }).get(key);
    expect(Buffer.compare(got, bytes)).toBe(0);
    expect(calls[0].url).toContain(`/storage/v1/object/`);
    expect(calls[0].url).toContain(`assessment-files/${key}`);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("a missing object is \"not found\" (ENOENT), like the other drivers", async () => {
    const { fetchFn } = fakeFetch(() => json({ statusCode: "404", error: "not_found", message: "Object not found" }, 404));
    await expect(new SupabaseStorage({ url: URL_, serviceRoleKey: KEY, bucket: "assessment-files", fetch: fetchFn }).get(key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes idempotently (removing a missing object succeeds)", async () => {
    const { calls, fetchFn } = fakeFetch(() => json([]));
    await new SupabaseStorage({ url: URL_, serviceRoleKey: KEY, bucket: "assessment-files", fetch: fetchFn }).delete(key);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`${URL_}/storage/v1/object/assessment-files`);
    expect(JSON.parse(String(calls[0].body))).toEqual({ prefixes: [key] });
  });

  it("surfaces Storage errors (e.g. an existing object) without the key or any secret", async () => {
    const { fetchFn } = fakeFetch(() => json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 409));
    const err = await new SupabaseStorage({ url: URL_, serviceRoleKey: KEY, bucket: "assessment-files", fetch: fetchFn }).put(key, Buffer.from("x")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Storage upload failed/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("only accepts server-generated keys — nothing is requested for anything else", async () => {
    const { calls, fetchFn } = fakeFetch(() => json({}));
    const s = new SupabaseStorage({ url: URL_, serviceRoleKey: KEY, bucket: "assessment-files", fetch: fetchFn });
    for (const bad of ["../secrets.pdf", "answer/2026/10/x.pdf", "other/2026/10/00000000-0000-0000-0000-000000000000.pdf"]) {
      await expect(s.put(bad, Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
      await expect(s.get(bad)).rejects.toThrow(/Invalid storage key/);
      await expect(s.delete(bad)).rejects.toThrow(/Invalid storage key/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Supabase storage settings", () => {
  const DB = "postgresql://u:p@db.internal:5432/assessment";
  const PROD = {
    NODE_ENV: "production",
    DATABASE_URL: DB,
    APP_URL: "https://assessments.example.org",
    EMAIL_PROVIDER: "outbox",
    MALWARE_SCANNER: "none",
    TRUST_PROXY: "true",
    STORAGE_DRIVER: "supabase",
    SUPABASE_URL: URL_,
    SUPABASE_SERVICE_ROLE_KEY: KEY,
  };

  it("production accepts the supabase driver with URL and key; the bucket defaults to assessment-files", () => {
    expect(parseEnv(PROD)).toMatchObject({ STORAGE_DRIVER: "supabase", SUPABASE_URL: URL_, SUPABASE_STORAGE_BUCKET: "assessment-files" });
    expect(parseEnv({ ...PROD, SUPABASE_STORAGE_BUCKET: "other-bucket" }).SUPABASE_STORAGE_BUCKET).toBe("other-bucket");
    // STORAGE_LOCAL_DIR is only needed by the local driver.
    expect(parseEnv(PROD).STORAGE_LOCAL_DIR).toBeUndefined();
  });

  it("production refuses a missing URL or key, or a non-https URL — without echoing values", () => {
    expect(() => parseEnv({ ...PROD, SUPABASE_URL: undefined })).toThrow(/SUPABASE_URL is required/);
    expect(() => parseEnv({ ...PROD, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(/SUPABASE_SERVICE_ROLE_KEY is required/);
    expect(() => parseEnv({ ...PROD, SUPABASE_URL: "http://example-project.supabase.co" })).toThrow(/https/);
    const err = (() => {
      try {
        parseEnv({ ...PROD, SUPABASE_URL: undefined });
      } catch (e) {
        return String(e);
      }
    })();
    expect(err).not.toContain(KEY);
  });

  it("outside production the supabase driver still needs its URL and key; local and memory are unchanged", () => {
    expect(() => parseEnv({ NODE_ENV: "development", DATABASE_URL: DB, STORAGE_DRIVER: "supabase" })).toThrow(/SUPABASE_URL is required/);
    expect(parseEnv({ NODE_ENV: "development", DATABASE_URL: DB }).STORAGE_DRIVER).toBe("local");
    expect(parseEnv({ NODE_ENV: "test", DATABASE_URL: DB, STORAGE_DRIVER: "memory" }).STORAGE_DRIVER).toBe("memory");
    expect(() => parseEnv({ ...PROD, STORAGE_DRIVER: "local" })).toThrow(/STORAGE_LOCAL_DIR/);
  });

  it("refuses an invalid bucket name", () => {
    expect(() => parseEnv({ ...PROD, SUPABASE_STORAGE_BUCKET: "Bad Bucket!" })).toThrow(/SUPABASE_STORAGE_BUCKET/);
  });

  it("the service-role key can never be a NEXT_PUBLIC_ (browser-exposed) variable", () => {
    expect(() => parseEnv({ ...PROD, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: KEY })).toThrow(/never be a NEXT_PUBLIC_/);
    expect(() => parseEnv({ NODE_ENV: "development", DATABASE_URL: DB, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(/never be a NEXT_PUBLIC_/);
  });
});
