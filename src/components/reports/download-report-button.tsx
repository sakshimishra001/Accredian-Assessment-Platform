"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/prototype/toast";

/** The file name from Content-Disposition (the UTF-8 form when present). */
function fileNameFrom(header: string | null, fallback: string) {
  const utf8 = header && /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {}
  }
  const plain = header && /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : fallback;
}

/**
 * Generates a report on the server and saves it. Failures (no access, nothing to report, a server
 * error) are shown as a message instead of downloading an error page.
 */
export function DownloadReportButton({ href, label, fallbackName, variant = "outline", disabled }: { href: string; label: string; fallbackName: string; variant?: "outline" | "default"; disabled?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(href, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = res.status === 401 ? "Your session has ended. Please sign in again." : (body?.error ?? `The report couldn’t be generated (${res.status}).`);
        return toast.error(`${label} failed`, message);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileNameFrom(res.headers.get("content-disposition"), fallbackName);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error(`${label} failed`, "No connection — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant={variant} onClick={download} disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />} {label}
    </Button>
  );
}
