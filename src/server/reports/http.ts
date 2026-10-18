import "server-only";

/** A generated report as a download: never cached, never sniffed, not readable by other sites. */
export function reportResponse(report: { fileName: string; contentType: string; data: Uint8Array }) {
  const ascii = report.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(new Uint8Array(report.data), {
    status: 200,
    headers: {
      "Content-Type": report.contentType,
      "Content-Length": String(report.data.byteLength),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(report.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
