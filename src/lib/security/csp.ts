/*
 * Content-Security-Policy for the app's pages, built per request with a fresh nonce (see proxy.ts).
 *
 * Scripts: only those carrying the request's nonce — Next.js adds it to its own scripts during
 * dynamic rendering — and what they load ('strict-dynamic'). No inline or third-party scripts.
 * Styles: 'unsafe-inline' is still allowed — the UI uses inline style attributes (positioning,
 * progress widths) that nonces can't cover. Script injection stays blocked; this is the documented
 * remaining gap. Development additionally needs 'unsafe-eval' (React debugging) and websockets (HMR).
 * WebAssembly: 'wasm-unsafe-eval' (compiling WebAssembly only — not JavaScript eval) is allowed on
 * the learner's exam pages alone, for the in-browser face detector (proctoring); nowhere else.
 */

export interface CspOptions {
  nonce: string;
  dev: boolean;
  /** Add upgrade-insecure-requests (only when the app is served over HTTPS). */
  upgradeInsecure: boolean;
  /** Allow compiling WebAssembly ('wasm-unsafe-eval') — see allowsWasm(). */
  wasm?: boolean;
  /**
   * An origin images may also come from: the Supabase project serving proctoring evidence by
   * short-lived signed URL — only on the proctor pages (see allowsEvidenceImages()).
   */
  imageOrigin?: string | null;
}

/** The pages that show proctoring evidence images (signed URLs from the storage origin). */
export const allowsEvidenceImages = (pathname: string) => pathname.startsWith("/proctor/");

/** The origin of an http(s) URL, or null. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The pages that may compile WebAssembly: the learner's exam (/learner/assessment/…), for face detection. */
export const allowsWasm = (pathname: string) => pathname.startsWith("/learner/assessment/");

export function contentSecurityPolicy({ nonce, dev, upgradeInsecure, wasm = false, imageOrigin = null }: CspOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${wasm ? " 'wasm-unsafe-eval'" : ""}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${imageOrigin ? ` ${imageOrigin}` : ""}`,
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    // In-app PDF preview embeds the app's own file route.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(upgradeInsecure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** A fresh, unpredictable nonce (128 bits, base64). */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
