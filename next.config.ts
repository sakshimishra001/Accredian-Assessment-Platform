import type { NextConfig } from "next";

/*
 * Security headers for every response. The Content-Security-Policy for pages is set per request
 * (with a nonce) in src/proxy.ts; file downloads set their own CSP in src/server/files/http.ts.
 */
const isProduction = process.env.NODE_ENV === "production";

/** Browser features the app may use: none — except the camera on the learner's exam pages (below). Never the microphone. */
const permissionsPolicy = (camera: "()" | "(self)") => ({ key: "Permissions-Policy", value: `camera=${camera}, microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` });

const common = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  permissionsPolicy("()"),
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Browsers ignore HSTS over plain HTTP; sent only by production builds.
  ...(isProduction ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  // The dev-mode badge overlaps the sidebar profile during prototype demos.
  devIndicators: false,
  poweredByHeader: false,
  experimental: {
    // The project lives in a OneDrive folder; OneDrive locks Turbopack's on-disk cache files,
    // which can crash `next dev`. Keeping the dev cache in memory avoids that.
    turbopackFileSystemCacheForDev: false,
  },
  async headers() {
    return [
      // Nothing of the app may be framed by another site…
      { source: "/((?!api/files/).*)", headers: [...common, { key: "X-Frame-Options", value: "DENY" }] },
      // …except stored files, which the app itself shows in an in-app PDF preview.
      { source: "/api/files/:path*", headers: [...common, { key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      // Self-hosted face-detection runtime and model (proctoring): versioned paths, so cached for good.
      { source: "/vendor/mediapipe/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // The learner's exam page may use the camera (proctoring's camera check), for this origin only.
      // Listed last: for the same header key the last matching rule wins.
      { source: "/learner/assessment/:path*", headers: [permissionsPolicy("(self)")] },
    ];
  },
};

export default nextConfig;
