// Shared readers for atlas pages as TinyFetch returns them: markdown tables under "## Name (N)" headers.

/** A backslash before ASCII punctuation (CommonMark): `\*` is `*`, `\|` is `|`. */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;

/**
 * The trimmed cells of a markdown table line, or null when the line is not a table line. Cells split
 * on unescaped pipes only, and a backslash escape is read as the character it escapes, so a cell
 * holds the city's own text (`TYPE-\*` is `TYPE-*`).
 */
export function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  for (let i = 1; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === "\\" && i + 1 < t.length) {
      cell += ch + t[i + 1]!;
      i++;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  // text after the last pipe is a cell when the line has no closing pipe
  if (cell.trim() !== "" || cells.length === 0) cells.push(cell);
  return cells.map((c) => c.trim().replace(ESCAPE, "$1"));
}

/** A "| --- | :---: |" row. */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

export interface MdTable {
  /** The first table line's cells; for a key/value table these are blank. */
  columns: string[];
  /** Every line after the column row and the separator. */
  rows: string[][];
}

export interface MdSection {
  /** The header text without its count ("Registered Community Organizations (RCOs)"); null for the text above the first "##". */
  title: string | null;
  /** N from "## Name (N)" (commas allowed); null when the header has no count. */
  count: number | null;
  /** Non-table lines, trimmed, blanks dropped. */
  text: string[];
  tables: MdTable[];
}

export interface MdPage {
  /** The text above the first "##" header (H1, intro, the li building table). */
  preamble: MdSection;
  sections: MdSection[];
}

const HEADER = /^##\s+(.*?)(?:\s*\(([\d,]+)\))?\s*$/;

/** Splits a page at its "## " headers ("###" lines stay inside the section), collecting each part's tables. */
export function splitSections(markdown: string): MdPage {
  const preamble: MdSection = { title: null, count: null, text: [], tables: [] };
  const sections: MdSection[] = [];
  let current = preamble;
  let table: string[][] | null = null;

  const closeTable = () => {
    if (table !== null) current.tables.push(toTable(table));
    table = null;
  };

  for (const line of markdown.split("\n")) {
    const header = /^##\s/.test(line) ? HEADER.exec(line.trim()) : null;
    if (header !== null) {
      closeTable();
      current = { title: header[1]!.trim(), count: header[2] === undefined ? null : Number(header[2].replace(/,/g, "")), text: [], tables: [] };
      sections.push(current);
      continue;
    }
    const cells = tableCells(line);
    if (cells !== null) {
      (table ??= []).push(cells);
      continue;
    }
    closeTable();
    if (line.trim() !== "") current.text.push(line.trim());
  }
  closeTable();
  return { preamble, sections };
}

/**
 * A column's name without the words of its sort button. The atlas sometimes serves a table's
 * headings as "Date   Sort table by Date in descending order" (2314 Brown St, 12 November 2026).
 */
const SORT_BUTTON = /\s+Sort table by .* in (?:ascending|descending) order$/i;
function columnName(cell: string): string {
  return cell.replace(SORT_BUTTON, "").trim();
}

function toTable(lines: string[][]): MdTable {
  if (lines.length >= 2 && isSeparatorRow(lines[1]!)) return { columns: lines[0]!.map(columnName), rows: lines.slice(2) };
  return { columns: [], rows: lines };
}

/** The section with this title (case-insensitive), if the page has it. */
export function findSection(page: MdPage, title: string): MdSection | undefined {
  const want = title.toLowerCase();
  return page.sections.find((s) => s.title?.toLowerCase() === want);
}

/** A two-column "| Key | Value |" table as an object; the first value of a repeated key wins. */
export function keyValues(table: MdTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of table.rows) {
    if (row.length >= 2 && row[0] !== "" && !Object.hasOwn(out, row[0]!)) out[row[0]!] = row[1]!;
  }
  return out;
}

/** Every key/value table on the page (a table whose column row is blank, "|  |  |"), merged; the first value of a key wins. */
export function pageKeyValues(page: MdPage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of [page.preamble, ...page.sections]) {
    for (const table of part.tables) {
      if (table.columns.length === 0 || table.columns.some((c) => c !== "")) continue;
      for (const [k, v] of Object.entries(keyValues(table))) if (!Object.hasOwn(out, k)) out[k] = v;
    }
  }
  return out;
}

/** The value of a key, or null when the page does not have it. */
export function valueOf(kv: Record<string, string>, key: string): string | null {
  return Object.hasOwn(kv, key) ? kv[key]! : null;
}

/**
 * A message in a table row rather than a record: only the first cell is filled, and the section
 * counts 0 or the text is an empty-state or Loading line ("No previous zoning legislation
 * published", "Loading permits..."). A record with blank trailing cells (an overlay without a code
 * section) is still a record.
 */
function isMessageRow(row: string[], count: number | null): boolean {
  if (row[0] === undefined || row[0] === "" || row.slice(1).some((c) => c !== "")) return false;
  return count === 0 || /^(?:no|loading)\b/i.test(row[0]);
}

/**
 * Thrown inside a parser when the page lacks what makes it a read of its tab (an anchor, a column
 * a list needs). The parser's entry point turns it into null with `orUnrecognised`.
 */
export class UnrecognisedPage extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnrecognisedPage";
  }
}

/** `read()`'s result, or null when it found the page unrecognisable. */
export function orUnrecognised<T>(read: () => T): T | null {
  try {
    return read();
  } catch (e) {
    if (e instanceof UnrecognisedPage) return null;
    throw e;
  }
}

/**
 * The records of a section's first table as objects keyed by column name. Blank rows and message
 * rows are skipped. A list that is absent is empty (an uncounted list may be missing from a real
 * page), and so is a list counted 0. A counted list without a table, or a table that lacks one of
 * `columns` (or has no column row), is not a read of the page: `UnrecognisedPage`, never rows of ""
 * values keyed on nothing.
 */
const SLASH_DATE = /^\d{2}\/\d{2}\/\d{4}$/;

/**
 * A row one cell short, starting with a date, in a table whose first column holds no date and whose
 * second does: the page left the first cell empty and the empty cell did not survive. The cell is put
 * back, empty, so the rest sit under their own headings. Any other short row is left as it came.
 */
function restoreEmptyFirstCell(row: string[], columns: readonly string[]): string[] {
  if (row.length !== columns.length - 1 || !SLASH_DATE.test(row[0] ?? "")) return row;
  if (/date/i.test(columns[0] ?? "") || !/date/i.test(columns[1] ?? "")) return row;
  return ["", ...row];
}

export function records(section: MdSection | undefined, columns: readonly string[]): Record<string, string>[] {
  if (section === undefined || section.count === 0) return [];
  const table = section.tables[0];
  if (table === undefined) {
    if (section.count !== null) throw new UnrecognisedPage(`${section.title}: counted ${section.count}, no table`);
    return [];
  }
  const missing = columns.filter((c) => !table.columns.includes(c));
  if (missing.length > 0) throw new UnrecognisedPage(`${section.title}: no column ${missing.join(", ")}`);
  const out: Record<string, string>[] = [];
  for (const cells of table.rows) {
    if (cells.every((c) => c === "") || isMessageRow(cells, section.count)) continue;
    const row = restoreEmptyFirstCell(cells, table.columns);
    const rec: Record<string, string> = {};
    table.columns.forEach((col, i) => {
      rec[col] = row[i] ?? "";
    });
    out.push(rec);
  }
  return out;
}

// --- Values ---------------------------------------------------------------------------------

/** "09/17/1993" or "1993-09-17" as "1993-09-17"; null for anything else ("To Be Determined", "13/45/2020"). */
export function usDate(raw: string | null | undefined): string | null {
  const s = raw?.trim() ?? "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso !== null) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return s;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m === null) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "$148,232,900", "USD 148,232,900" or "148,232,900" as 148232900; null when the string is not an amount. */
export function usd(raw: string | null | undefined): number | null {
  const m = /^(?:USD\s*)?\$?\s*([\d,]+(?:\.\d+)?)$/i.exec(raw?.trim() ?? "");
  return m === null ? null : Number(m[1]!.replace(/,/g, ""));
}

/** "723,780 sq ft" with unit "sq ft" as 723780; null when the string is not that number and unit. */
export function measure(raw: string | null | undefined, unit: string): number | null {
  const s = raw?.trim() ?? "";
  if (!s.toLowerCase().endsWith(unit.toLowerCase())) return null;
  const n = s.slice(0, s.length - unit.length).trim();
  return /^[\d,]+(?:\.\d+)?$/.test(n) ? Number(n.replace(/,/g, "")) : null;
}

/** A plain whole number ("8", "1,234"); null otherwise ("N/A"). */
export function wholeNumber(raw: string | null | undefined): number | null {
  const s = raw?.trim() ?? "";
  return /^\d[\d,]*$/.test(s) ? Number(s.replace(/,/g, "")) : null;
}

/** "Yes" / "No" as a boolean; null otherwise. */
export function yesNo(raw: string | null | undefined): boolean | null {
  const s = raw?.trim().toLowerCase();
  return s === "yes" ? true : s === "no" ? false : null;
}

/** An empty cell as null. */
export function orNull(raw: string | null | undefined): string | null {
  const s = raw?.trim() ?? "";
  return s === "" ? null : s;
}

/** N from "There is 1 active parcel" / "There are 3 active parcels"; null when the page does not say. */
export function activeParcels(markdown: string): number | null {
  const m = /There (?:is|are) (\d+) active parcels?\b/i.exec(markdown);
  return m === null ? null : Number(m[1]);
}

/** The page's H1 ("# 1234 MARKET ST"). */
export function pageTitle(markdown: string): string | null {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-30" as "30 Oct 2026", the date form of event summaries (DESIGN.md copy voice). */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
}

/** A record's cell by column name; "" when the table has no such column. */
export function cell(rec: Record<string, string>, column: string): string {
  return Object.hasOwn(rec, column) ? rec[column]! : "";
}
