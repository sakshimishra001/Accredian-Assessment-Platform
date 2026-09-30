const dateTimeFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export function formatDateTime(value: Date | null | undefined): string {
  return value ? dateTimeFormat.format(value) : "—";
}

export function formatDate(value: Date | null | undefined): string {
  return value ? dateFormat.format(value) : "—";
}
