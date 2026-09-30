"use client";

// Last-resort boundary for errors in the root layout. Must render its own <html>/<body>
// and cannot rely on global CSS, so it uses inline styles.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 16 }}>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#666", fontSize: 14 }}>
            The application failed to load.{error.digest ? ` Reference: ${error.digest}` : ""}
          </p>
          <button onClick={() => retry()} style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
