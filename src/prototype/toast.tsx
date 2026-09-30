"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "cn";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastApi {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  /** Standard notice for controls that are intentionally not built in the prototype. */
  comingSoon: (feature?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON = { success: CircleCheck, error: CircleAlert, info: Info };
const TONE = {
  success: "text-emerald-600",
  error: "text-destructive",
  info: "text-primary",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (kind: ToastKind, title: string, description?: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-2), { id, kind, title, description }]);
      setTimeout(() => dismiss(id), kind === "error" ? 5000 : 3500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, d) => push("success", t, d),
      error: (t, d) => push("error", t, d),
      info: (t, d) => push("info", t, d),
      comingSoon: (feature) =>
        push("info", "Coming in a future version", feature ? `${feature} is not part of this prototype.` : "This is a prototype-only control."),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <div
              key={t.id}
              role="status"
              className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-sm shadow-lg animate-in fade-in slide-in-from-bottom-2"
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[t.kind])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                {t.description ? <p className="mt-0.5 text-muted-foreground">{t.description}</p> : null}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
