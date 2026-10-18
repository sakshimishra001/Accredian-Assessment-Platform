import { CsvError, parseCsv } from "@/lib/papers/csv";

export const MAX_LEARNER_ROWS = 1000;
export const MAX_LEARNER_CSV_BYTES = 1024 * 1024;

export interface LearnerCsvRow {
  /** 1-based spreadsheet row (the header is row 1). */
  row: number;
  name: string;
  email: string;
}

/**
 * Read a learner CSV with `name` and `email` columns (case-insensitive; other columns such as
 * phone are ignored). Returns the rows as written — validation happens in the import service.
 */
export function parseLearnerCsv(text: string): { rows: LearnerCsvRow[]; error: string | null } {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    return { rows: [], error: err instanceof CsvError ? `The file couldn’t be read: ${err.message}` : "The file couldn’t be read." };
  }
  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { rows: [], error: "The file is empty." };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const nameCol = header.indexOf("name");
  const emailCol = header.indexOf("email");
  if (nameCol < 0 || emailCol < 0) return { rows: [], error: "The file needs a header row with “name” and “email” columns." };

  const rows: LearnerCsvRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (!cells.some((c) => c.trim() !== "")) continue;
    rows.push({ row: i + 1, name: (cells[nameCol] ?? "").trim(), email: (cells[emailCol] ?? "").trim() });
  }
  if (rows.length === 0) return { rows, error: "The file has a header but no learners." };
  if (rows.length > MAX_LEARNER_ROWS) return { rows: [], error: `Too many rows: at most ${MAX_LEARNER_ROWS} learners per import.` };
  return { rows, error: null };
}
