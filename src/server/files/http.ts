import "server-only";
import { DomainError, ValidationError } from "@/lib/errors";
import { FILE_TYPES } from "@/lib/files/types";
import { getCurrentUser } from "../auth/current-user";
import type { SessionUser } from "../auth/session";
import { env } from "../env";

/*
 * Shared plumbing for the file route handlers: authentication, multipart parsing, error → status
 * mapping and safe download headers. Authorisation itself lives in the file service.
 */

const STATUS: Record<DomainError["code"], number> = { VALIDATION: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 };

/** A refusal with a specific HTTP status (413 too large, 403 cross-site, 415 wrong content type). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON error body in the same shape as ActionResult failures. */
export function errorResponse(err: unknown) {
  if (err instanceof HttpError) return Response.json({ ok: false, error: err.message }, { status: err.status });
  if (err instanceof DomainError) return Response.json({ ok: false, error: err.message, fieldErrors: err.fieldErrors }, { status: STATUS[err.code] });
  console.error(err);
  return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
}

/** The signed-in user, or a 401 response. */
export async function requireApiUser(): Promise<SessionUser | Response> {
  const user = await getCurrentUser();
  return user ?? Response.json({ ok: false, error: "Please sign in again." }, { status: 401 });
}

/**
 * Same-origin check for state-changing route handlers (server actions have Next.js's own check).
 * Browsers send Sec-Fetch-Site and Origin on these requests: anything but a same-origin request
 * from this app is refused — cross-site, same-site (another subdomain), or with neither header.
 */
export function assertSameOrigin(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new HttpError(403, "Cross-site request refused.");
  const origin = request.headers.get("origin");
  if (!origin) {
    if (site === "same-origin") return;
    throw new HttpError(403, "Cross-site request refused.");
  }
  const allowed = new Set([new URL(request.url).origin, new URL(env().APP_URL).origin]);
  const host = request.headers.get("host");
  if (host) allowed.add(`${new URL(request.url).protocol}//${host}`);
  if (!allowed.has(origin)) throw new HttpError(403, "Cross-site request refused.");
}

/** Room for the multipart boundaries and the small text fields around the file. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Read the request body, refusing more than `maxBytes`: rejected up front when Content-Length says
 * so, and cut off while streaming when it is missing or wrong — the body is never buffered beyond
 * the limit.
 */
async function readBodyLimited(request: Request, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new HttpError(413, `The upload is too large. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw tooLarge();
  if (!request.body) throw new ValidationError("Send the file as multipart/form-data.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Read one uploaded file and the text fields of a multipart request, never accepting a body larger
 * than `maxFileBytes` plus multipart overhead. Per-file size and type rules are applied later by
 * the file service.
 */
export async function readUpload(request: Request, maxFileBytes: number) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new HttpError(415, "Send the file as multipart/form-data.");
  const body = await readBodyLimited(request, maxFileBytes + MULTIPART_OVERHEAD_BYTES);
  let form: FormData;
  try {
    form = await new Request("http://upload.local/", { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(body) }).formData();
  } catch {
    throw new ValidationError("Send the file as multipart/form-data.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("Choose a file to upload.", { file: ["Choose a file"] });
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return { upload: { name: file.name, data: Buffer.from(await file.arrayBuffer()) }, field };
}

/**
 * Serve a stored file. Inline only for types the app previews (image, PDF, CSV/text); everything
 * else downloads. The content type is the server's, never sniffed; SVG and text are sandboxed.
 */
export function fileResponse(file: { fileName: string; extension: string; mimeType: string }, data: Buffer, inline: boolean) {
  const preview = FILE_TYPES[file.extension]?.preview ?? null;
  // SVG (no longer accepted, but older files are still served) never opens as a page of its own.
  const disposition = inline && preview && file.extension !== "svg" ? "inline" : "attachment";
  const ascii = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers = new Headers({
    "Content-Type": preview === "csv" || preview === "text" ? `${file.mimeType}; charset=utf-8` : file.mimeType,
    "Content-Length": String(data.length),
    "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    // Other sites can't embed or fetch these responses with the user's cookies.
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  // Only this app may frame a file (the in-app PDF preview). SVG and text open in a script-less sandbox.
  headers.set(
    "Content-Security-Policy",
    file.extension === "svg" || preview === "text" || preview === "csv" ? "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox" : "frame-ancestors 'self'",
  );
  return new Response(new Uint8Array(data), { status: 200, headers });
}
