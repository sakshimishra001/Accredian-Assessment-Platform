import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/*
 * A small document layout on top of pdf-lib for the result reports: A4 pages with an Accredian
 * header, wrapped text, key/value blocks and tables whose rows may run over several pages, and a
 * "Page X of Y" footer. Text uses the standard PDF fonts (no font files to ship); characters they
 * can't show are replaced (see `pdfSafe`).
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 42;
const TOP = 78; // below the header band
const BOTTOM = 52; // above the footer
const BRAND = rgb(48 / 255, 76 / 255, 181 / 255);
const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.86, 0.87, 0.9);
const SHADE = rgb(0.955, 0.96, 0.975);

// Characters outside Latin-1 that the standard fonts' WinAnsi encoding does include.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const REPLACE: Record<string, string> = { "−": "-", "≤": "<=", "≥": ">=", "≠": "!=", "→": "->", "←": "<-", "✓": "v", "✔": "v", "✗": "x", "×": "x", " ": " ", "​": "", "﻿": "" };

/** Text the standard fonts can draw: tabs become spaces, control characters go, others become "?". */
export function pdfSafe(text: string) {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n" || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (ch in REPLACE) out += REPLACE[ch];
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    else out += "?";
  }
  return out;
}

export interface Column {
  header: string;
  /** Share of the table width. */
  width: number;
  align?: "left" | "right";
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

export class ReportDocument {
  private pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  readonly width = A4[0] - MARGIN * 2;

  private constructor(
    private doc: PDFDocument,
    private fonts: Fonts,
    private reportTitle: string,
    private generatedAt: string,
  ) {}

  static async create(title: string, generatedAt: string) {
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setAuthor("Accredian");
    doc.setCreator("Accredian Assessment Platform");
    doc.setProducer("Accredian Assessment Platform");
    const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), italic: await doc.embedFont(StandardFonts.HelveticaOblique) };
    const r = new ReportDocument(doc, fonts, pdfSafe(title), generatedAt);
    r.newPage();
    return r;
  }

  private newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    const [w, h] = A4;
    this.page.drawRectangle({ x: 0, y: h - 54, width: w, height: 54, color: BRAND });
    this.page.drawText("Accredian", { x: MARGIN, y: h - 34, size: 16, font: this.fonts.bold, color: rgb(1, 1, 1) });
    const label = "Assessment Platform";
    this.page.drawText(label, { x: MARGIN + this.fonts.bold.widthOfTextAtSize("Accredian", 16) + 8, y: h - 33, size: 9, font: this.fonts.regular, color: rgb(0.85, 0.88, 1) });
    const t = this.fit(this.reportTitle, this.fonts.bold, 10, w / 2);
    this.page.drawText(t, { x: w - MARGIN - this.fonts.bold.widthOfTextAtSize(t, 10), y: h - 33, size: 10, font: this.fonts.bold, color: rgb(1, 1, 1) });
    this.y = h - TOP;
  }

  /** Shorten a single line to `width` with an ellipsis. */
  private fit(text: string, font: PDFFont, size: number, width: number) {
    if (font.widthOfTextAtSize(text, size) <= width) return text;
    let s = text;
    while (s && font.widthOfTextAtSize(`${s}...`, size) > width) s = s.slice(0, -1);
    return `${s}...`;
  }

  /** Wrap text to `width`: on spaces, breaking words longer than a line; blank lines are kept. */
  wrap(text: string, font: PDFFont, size: number, width: number) {
    const lines: string[] = [];
    for (const para of pdfSafe(text).split("\n")) {
      if (!para.trim()) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const word of para.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = "";
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > width) {
          let n = rest.length;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
          lines.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }

  private room() {
    return this.y - BOTTOM;
  }

  private ensure(height: number) {
    if (this.room() < height) this.newPage();
  }

  space(h: number) {
    if (this.room() < h) this.newPage();
    else this.y -= h;
  }

  heading(text: string) {
    this.ensure(40);
    this.y -= 6;
    this.page.drawText(this.fit(pdfSafe(text), this.fonts.bold, 12, this.width), { x: MARGIN, y: this.y - 12, size: 12, font: this.fonts.bold, color: BRAND });
    this.y -= 17;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + this.width, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= 8;
  }

  title(text: string, subtitle?: string) {
    for (const line of this.wrap(text, this.fonts.bold, 18, this.width)) {
      this.ensure(24);
      this.page.drawText(line, { x: MARGIN, y: this.y - 18, size: 18, font: this.fonts.bold, color: INK });
      this.y -= 23;
    }
    if (subtitle) this.paragraph(subtitle, { size: 9, color: "muted" });
    this.y -= 4;
  }

  /** Wrapped text, page-breaking line by line (so a long answer can run over pages). */
  paragraph(text: string, opts: { size?: number; bold?: boolean; italic?: boolean; color?: "ink" | "muted"; indent?: number; shade?: boolean } = {}) {
    const size = opts.size ?? 9.5;
    const lh = size * 1.38;
    const font = opts.bold ? this.fonts.bold : opts.italic ? this.fonts.italic : this.fonts.regular;
    const indent = opts.indent ?? 0;
    const pad = opts.shade ? 6 : 0;
    const lines = this.wrap(text, font, size, this.width - indent - pad * 2);
    let i = 0;
    while (i < lines.length) {
      this.ensure(lh + pad * 2);
      const fits = Math.max(1, Math.floor((this.room() - pad * 2) / lh));
      const chunk = lines.slice(i, i + fits);
      if (opts.shade) this.page.drawRectangle({ x: MARGIN + indent, y: this.y - chunk.length * lh - pad * 2, width: this.width - indent, height: chunk.length * lh + pad * 2, color: SHADE });
      let y = this.y - pad;
      for (const line of chunk) {
        if (line) this.page.drawText(line, { x: MARGIN + indent + pad, y: y - size, size, font, color: opts.color === "muted" ? MUTED : INK });
        y -= lh;
      }
      this.y = y - pad;
      i += chunk.length;
    }
    this.y -= 3;
  }

  /** Label / value pairs in two columns (values wrap). */
  facts(items: [string, string][], columns = 2) {
    const size = 9;
    const lh = 12.5;
    const colWidth = this.width / columns;
    const labelWidth = Math.min(98, colWidth * 0.42);
    for (let i = 0; i < items.length; i += columns) {
      const row = items.slice(i, i + columns).map(([k, v]) => ({ k: this.wrap(k, this.fonts.regular, size, labelWidth - 6), v: this.wrap(v || "-", this.fonts.bold, size, colWidth - labelWidth - 10) }));
      const height = Math.max(...row.map((c) => Math.max(c.k.length, c.v.length))) * lh + 4;
      this.ensure(height);
      row.forEach((c, j) => {
        const x = MARGIN + j * colWidth;
        c.k.forEach((line, n) => this.page.drawText(line, { x, y: this.y - size - n * lh, size, font: this.fonts.regular, color: MUTED }));
        c.v.forEach((line, n) => this.page.drawText(line, { x: x + labelWidth, y: this.y - size - n * lh, size, font: this.fonts.bold, color: INK }));
      });
      this.y -= height;
    }
    this.y -= 4;
  }

  /** A table with a repeated header; a row taller than the space left continues on the next page. */
  table(columns: Column[], rows: string[][]) {
    const size = 8.5;
    const lh = 11.5;
    const padX = 5;
    const padY = 4;
    const total = columns.reduce((a, c) => a + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const drawHeader = () => {
      const head = columns.map((c, i) => this.wrap(c.header, this.fonts.bold, size, widths[i] - padX * 2));
      const h = Math.max(...head.map((l) => l.length)) * lh + padY * 2;
      this.page.drawRectangle({ x: MARGIN, y: this.y - h, width: this.width, height: h, color: SHADE });
      head.forEach((lines, i) =>
        lines.forEach((line, n) => {
          const x = columns[i].align === "right" ? xs[i] + widths[i] - padX - this.fonts.bold.widthOfTextAtSize(line, size) : xs[i] + padX;
          this.page.drawText(line, { x, y: this.y - padY - size - n * lh + 1, size, font: this.fonts.bold, color: INK });
        }),
      );
      this.y -= h;
    };
    this.ensure(60);
    drawHeader();
    for (const row of rows) {
      const cells = row.map((v, i) => this.wrap(v || "-", this.fonts.regular, size, widths[i] - padX * 2));
      let offset = 0;
      const height = Math.max(...cells.map((c) => c.length));
      while (offset < height) {
        if (this.room() < lh + padY * 2) {
          this.newPage();
          drawHeader();
        }
        const fits = Math.max(1, Math.floor((this.room() - padY * 2) / lh));
        const n = Math.min(fits, height - offset);
        cells.forEach((lines, i) =>
          lines.slice(offset, offset + n).forEach((line, k) => {
            const x = columns[i].align === "right" ? xs[i] + widths[i] - padX - this.fonts.regular.widthOfTextAtSize(line, size) : xs[i] + padX;
            this.page.drawText(line, { x, y: this.y - padY - size - k * lh + 1, size, font: this.fonts.regular, color: INK });
          }),
        );
        this.y -= n * lh + padY * 2;
        this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + this.width, y: this.y }, thickness: 0.5, color: RULE });
        offset += n;
      }
    }
    this.y -= 8;
  }

  /** A thin divider between blocks. */
  rule() {
    this.ensure(10);
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + this.width, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 8;
  }

  /** Finish: footers with the generation time and "Page X of Y" on every page. */
  async save() {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const label = `Page ${i + 1} of ${total}`;
      p.drawLine({ start: { x: MARGIN, y: 36 }, end: { x: A4[0] - MARGIN, y: 36 }, thickness: 0.5, color: RULE });
      p.drawText(pdfSafe(`Generated ${this.generatedAt} · Accredian Assessment Platform · Confidential`), { x: MARGIN, y: 24, size: 7.5, font: this.fonts.regular, color: MUTED });
      p.drawText(label, { x: A4[0] - MARGIN - this.fonts.regular.widthOfTextAtSize(label, 7.5), y: 24, size: 7.5, font: this.fonts.regular, color: MUTED });
    });
    return this.doc.save();
  }

  get pageCount() {
    return this.pages.length;
  }
}
