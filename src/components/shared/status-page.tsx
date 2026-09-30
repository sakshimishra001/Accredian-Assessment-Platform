import type { ReactNode } from "react";

/** Centered full-page message used by the error, 404 and 403 screens. */
export function StatusPage({
  code,
  title,
  description,
  children,
}: {
  code?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="max-w-md text-center">
        {code ? <p className="text-sm font-semibold text-muted-foreground">{code}</p> : null}
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {children ? <div className="mt-6 flex justify-center gap-3">{children}</div> : null}
      </div>
    </main>
  );
}
