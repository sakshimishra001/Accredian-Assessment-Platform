/** Accredian wordmark (sign-in pages), optionally with a line underneath. */
export function AccredianBrand({ inverted = false, subtitle = "Assessment Platform" }: { inverted?: boolean; subtitle?: string | null }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={
          inverted
            ? "flex size-10 items-center justify-center rounded-lg bg-white text-lg font-bold text-primary"
            : "flex size-10 items-center justify-center rounded-lg bg-primary text-lg font-bold text-primary-foreground"
        }
        aria-hidden
      >
        A
      </span>
      <span className="leading-tight">
        <span className={inverted ? "block text-lg font-semibold tracking-tight text-white" : "block text-lg font-semibold tracking-tight"}>Accredian</span>
        {subtitle ? <span className={inverted ? "block text-sm text-white/80" : "block text-sm text-muted-foreground"}>{subtitle}</span> : null}
      </span>
    </div>
  );
}
