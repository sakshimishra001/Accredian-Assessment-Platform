"use client";

// In-app preview for any prototype file — admin supporting material or a learner's answer attachment.
// Never opens a new tab or downloads anything; all content is mock.

import { useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileCode2, FileImage, FileSpreadsheet, FileText, Presentation } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/prototype/toast";

export interface ViewableFile {
  name: string;
  ext: string;
  sizeKb: number;
  description?: string;
}

export type FileFamily = "image" | "document" | "spreadsheet" | "presentation" | "code";

export function familyOf(ext: string): FileFamily {
  if (["png", "jpg", "jpeg", "svg"].includes(ext)) return "image";
  if (["csv", "xls", "xlsx"].includes(ext)) return "spreadsheet";
  if (["ppt", "pptx"].includes(ext)) return "presentation";
  if (["txt", "py", "js", "sql"].includes(ext)) return "code";
  return "document";
}

const FAMILY_ICON: Record<FileFamily, typeof FileText> = {
  image: FileImage,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  code: FileCode2,
};

export function FileIcon({ ext, className, tone = "neutral" }: { ext: string; className?: string; tone?: "neutral" | "answer" }) {
  const Icon = FAMILY_ICON[familyOf(ext)];
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md",
        tone === "answer" ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 ring-inset" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

export function formatSize(kb: number) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

export function FileViewer({
  file,
  variant,
  context,
  onClose,
  allowDownload,
}: {
  file: ViewableFile | null;
  /** "material" = provided to the learner; "answer" = submitted by the learner. */
  variant: "material" | "answer";
  /** Extra label, e.g. "Question 7". */
  context?: string;
  onClose: () => void;
  allowDownload: boolean;
}) {
  const toast = useToast();
  return (
    <Dialog open={file !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        {file ? (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>{variant === "answer" ? "Your Submitted File" : "Supporting Material"}</DialogTitle>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                    variant === "answer" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-muted text-muted-foreground ring-border",
                  )}
                >
                  {variant === "answer" ? "Answer attachment" : "Provided with the question"}
                  {context ? ` · ${context}` : ""}
                </span>
              </div>
              <DialogDescription>
                <span className="font-medium text-foreground">{file.name}</span> · {file.ext.toUpperCase()} · {formatSize(file.sizeKb)}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[62vh] overflow-auto rounded-lg border bg-muted/40 p-4">
              <Preview file={file} />
            </div>
            {file.description ? <p className="text-sm text-muted-foreground">{file.description}</p> : null}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {allowDownload ? (
                <Button onClick={() => toast.info("Download simulated in prototype mode.", file.name)}>
                  <Download /> Download
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Preview({ file }: { file: ViewableFile }) {
  const family = familyOf(file.ext);
  if (family === "image") return <ImagePreview name={file.name} />;
  if (family === "presentation") return <SlidesPreview name={file.name} />;
  if (family === "code") return <CodePreview file={file} />;
  if (family === "spreadsheet") return file.ext === "csv" ? <TablePreview name={file.name} /> : <WorkbookPreview name={file.name} />;
  return <DocumentPreview name={file.name} />;
}

// ---------------------------------------------------------------------------
// Mock datasets
// ---------------------------------------------------------------------------

const PRODUCTS: [string, number, number][] = [
  ["Laptop", 125000, 45],
  ["Monitor", 85000, 31],
  ["Keyboard", 42000, 78],
  ["Mouse", 21000, 92],
];
const TOTAL_REVENUE = PRODUCTS.reduce((n, p) => n + p[1], 0);
const inr = (n: number) => n.toLocaleString("en-IN");

/** The learner's version of a dataset shows their added calculations. */
const isLearnerWork = (name: string) => /completed|final|analysis|answer/i.test(name);

function datasetFor(name: string): { head: string[]; rows: string[][]; foot?: string[] } {
  if (/regional/i.test(name)) {
    return {
      head: ["Region", "Q1 sales (₹ L)", "Q2 sales (₹ L)", "Q3 sales (₹ L)", "Growth"],
      rows: [
        ["West", "82.4", "91.0", "104.6", "+26.9%"],
        ["South", "74.1", "79.8", "88.2", "+19.0%"],
        ["North", "69.5", "71.2", "76.9", "+10.6%"],
        ["East", "41.3", "43.0", "45.8", "+10.9%"],
      ],
    };
  }
  if (isLearnerWork(name)) {
    return {
      head: ["Product", "Revenue", "Units", "Revenue per unit", "Share of revenue"],
      rows: PRODUCTS.map(([p, r, u]) => [p, inr(r), String(u), inr(Math.round(r / u)), `${((r / TOTAL_REVENUE) * 100).toFixed(1)}%`]),
      foot: ["Total", inr(TOTAL_REVENUE), String(PRODUCTS.reduce((n, p) => n + p[2], 0)), "—", "100.0%"],
    };
  }
  return { head: ["Product", "Revenue", "Units"], rows: PRODUCTS.map(([p, r, u]) => [p, inr(r), String(u)]) };
}

function Grid({ data, rowNumbers = true }: { data: ReturnType<typeof datasetFor>; rowNumbers?: boolean }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-muted text-xs text-muted-foreground">
        <tr>
          {rowNumbers ? <th className="w-10 px-2 py-1.5" /> : null}
          {data.head.map((h) => (
            <th key={h} className="px-3 py-1.5 text-left font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => (
          <tr key={r[0]} className="border-t">
            {rowNumbers ? <td className="px-2 py-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}</td> : null}
            {r.map((c, j) => (
              <td key={j} className={cn("px-3 py-1.5", j > 0 && "tabular-nums", j >= 3 && data.head.length > 3 && "bg-emerald-50/60")}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
      {data.foot ? (
        <tfoot>
          <tr className="border-t bg-muted/60 font-medium">
            {rowNumbers ? <td /> : null}
            {data.foot.map((c, j) => (
              <td key={j} className={cn("px-3 py-1.5", j > 0 && "tabular-nums")}>{c}</td>
            ))}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

function TablePreview({ name }: { name: string }) {
  const data = datasetFor(name);
  return (
    <div className="overflow-auto rounded-md bg-background shadow-sm ring-1 ring-border">
      <Grid data={data} />
      <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
        {name} · {data.rows.length} rows × {data.head.length} columns{isLearnerWork(name) ? " · includes added calculations" : ""} · mock preview
      </p>
    </div>
  );
}

function WorkbookPreview({ name }: { name: string }) {
  const [sheet, setSheet] = useState(0);
  const sheets = ["Analysis", "Raw data"];
  const data = sheet === 0 ? datasetFor(`${name} analysis`) : datasetFor("sales-data.csv");
  return (
    <div className="overflow-hidden rounded-md bg-background shadow-sm ring-1 ring-border">
      <div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-mono">fx</span>
        <span className="font-mono text-foreground">{sheet === 0 ? "=B2/C2" : "Laptop"}</span>
      </div>
      <div className="overflow-auto">
        <Grid data={data} />
      </div>
      <div className="flex gap-1 border-t bg-muted/40 px-2 py-1">
        {sheets.map((s, i) => (
          <button key={s} type="button" onClick={() => setSheet(i)} className={cn("rounded px-2 py-0.5 text-xs", sheet === i ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {s}
          </button>
        ))}
        <span className="ml-auto self-center text-[11px] text-muted-foreground">{name} · mock preview</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents, slides, images, code
// ---------------------------------------------------------------------------

type Page = { heading: string; body: string; table?: string[][] };

function pagesFor(name: string): Page[] {
  if (/instruction/i.test(name)) {
    return [
      { heading: "Task", body: "Open sales-data.csv. For each product, calculate revenue per unit (Revenue ÷ Units) and share of total revenue." },
      { heading: "Format", body: "Add two new columns to the same file — “Revenue per unit” and “Share of revenue” — and a Total row. Keep the original columns unchanged." },
      { heading: "Submit", body: "Save the file as sales-data-completed.csv (or .xlsx) and upload it under “Your Answer”. You can replace it any time before submitting." },
    ];
  }
  if (/template/i.test(name)) {
    return [
      { heading: "Recommendation", body: "State the product line you recommend prioritising and the expected impact." },
      { heading: "Evidence", body: "Summarise the figures from your analysis that support the recommendation." },
    ];
  }
  if (isLearnerWork(name) || /report|notes|recommendation/i.test(name)) {
    return [
      { heading: "Summary", body: "Laptops generate 46% of revenue but only 18% of units; revenue per unit is ₹2,778. Mice sell the most units at the lowest price." },
      { heading: "Recommendation", body: "Prioritise the laptop line next quarter and bundle mice and keyboards as accessories to lift attach rates." },
    ];
  }
  return [
    {
      heading: "1. Market overview",
      body: "The online professional-education market in India grew 18% year on year, driven by working professionals in Tier-1 and Tier-2 cities.",
      table: [["Region", "Learners (’000)", "YoY growth"], ["West", "412", "22%"], ["South", "356", "19%"], ["North", "298", "14%"], ["East", "171", "11%"]],
    },
    { heading: "2. Competitive landscape", body: "Three national providers hold 58% of the market. Completion rates remain the main differentiator cited by learners." },
    { heading: "3. Recommendation", body: "Prioritise the West region for launch: highest learner base, fastest growth and strongest employer partnerships." },
  ];
}

function DocumentPreview({ name }: { name: string }) {
  const pages = pagesFor(name);
  const [page, setPage] = useState(0);
  const p = pages[Math.min(page, pages.length - 1)];
  return (
    <div className="grid gap-3">
      <div className="mx-auto w-full max-w-xl rounded-sm bg-background px-10 py-8 shadow-sm ring-1 ring-border">
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{name.replace(/\.[^.]+$/, "")}</p>
        <h3 className="mt-4 text-base font-semibold">{p.heading}</h3>
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">{p.body}</p>
        {p.table ? (
          <table className="mt-4 w-full border text-xs">
            <tbody>
              {p.table.map((row, i) => (
                <tr key={row[0]} className={cn("border-t", i === 0 && "bg-muted font-medium")}>
                  {row.map((c) => (
                    <td key={c} className="px-2 py-1.5">{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="mt-4 grid gap-2" aria-hidden>
            {[92, 100, 86, 95, 70].map((w, i) => (
              <span key={i} className="h-2 rounded bg-muted" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        <p className="mt-8 text-right text-[11px] text-muted-foreground">Page {page + 1}</p>
      </div>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Button variant="ghost" size="icon-sm" disabled={page === 0} onClick={() => setPage((x) => x - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        Page {page + 1} of {pages.length}
        <Button variant="ghost" size="icon-sm" disabled={page >= pages.length - 1} onClick={() => setPage((x) => x + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function SlidesPreview({ name }: { name: string }) {
  const slides = ["Sales analysis — Q3", "Revenue by product", "Recommendation"];
  const [i, setI] = useState(0);
  return (
    <div className="grid gap-3">
      <div className="mx-auto flex aspect-video w-full max-w-xl flex-col justify-center rounded-sm bg-background px-10 shadow-sm ring-1 ring-border">
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{name.replace(/\.[^.]+$/, "")}</p>
        <p className="mt-2 text-xl font-semibold">{slides[i]}</p>
        <div className="mt-4 grid gap-2" aria-hidden>
          {[70, 55, 62].map((w, k) => (
            <span key={k} className="h-2 rounded bg-muted" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => setI((x) => x - 1)} aria-label="Previous slide">
          <ChevronLeft />
        </Button>
        Slide {i + 1} of {slides.length}
        <Button variant="ghost" size="icon-sm" disabled={i === slides.length - 1} onClick={() => setI((x) => x + 1)} aria-label="Next slide">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function CodePreview({ file }: { file: ViewableFile }) {
  const sample: Record<string, string> = {
    py: "import pandas as pd\n\ndf = pd.read_csv('sales-data.csv')\ndf['revenue_per_unit'] = df.Revenue / df.Units\ndf['share'] = df.Revenue / df.Revenue.sum()\nprint(df.round(2))",
    sql: "SELECT product,\n       revenue,\n       units,\n       revenue / units AS revenue_per_unit\nFROM sales\nORDER BY revenue DESC;",
    js: "const rows = await loadCsv('sales-data.csv');\nconst total = rows.reduce((n, r) => n + r.revenue, 0);\nrows.forEach((r) => (r.share = r.revenue / total));",
    txt: "Laptop: 2,778 per unit, 45.9% of revenue\nMonitor: 2,742 per unit, 31.2%\nKeyboard: 538 per unit, 15.4%\nMouse: 228 per unit, 7.7%",
  };
  return <pre className="overflow-auto rounded-md bg-background p-4 font-mono text-xs leading-relaxed shadow-sm ring-1 ring-border">{sample[file.ext] ?? sample.txt}</pre>;
}

function ImagePreview({ name }: { name: string }) {
  const share = [
    ["Laptop", 46],
    ["Monitor", 31],
    ["Keyboard", 15],
    ["Mouse", 8],
  ] as const;
  const regional = /share|market share/i.test(name) && !/chart/i.test(name);
  const data = regional
    ? ([
        ["West", 34],
        ["South", 27],
        ["North", 22],
        ["East", 17],
      ] as const)
    : share;
  return (
    <figure className="mx-auto max-w-lg rounded-md bg-background p-4 shadow-sm">
      <svg viewBox="0 0 400 220" className="w-full" role="img" aria-label={`Preview of ${name}`}>
        <text x="0" y="16" className="fill-foreground text-[13px] font-semibold">{regional ? "Market share by region (%)" : "Revenue share by product (%)"}</text>
        {data.map(([label, pct], i) => {
          const y = 40 + i * 42;
          const w = (pct / 50) * 290;
          return (
            <g key={label}>
              <text x="0" y={y + 17} className="fill-muted-foreground text-[12px]">{label}</text>
              <rect x="72" y={y} width={w} height="24" rx="4" fill="var(--chart-1)" />
              <text x={78 + w} y={y + 17} className="fill-foreground text-[12px] tabular-nums">{pct}%</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-center text-xs text-muted-foreground">{name} — mock preview</figcaption>
    </figure>
  );
}
