// Extended permit, violation and inspection lists from L&I Property History.
import { DEEP_ROWS_MAX } from "../core/limits";
import { classify, dateValue, instructions, numberValue, objectResult, optional, schema, validStopFlags } from "./agentCommon";
import type { AgentSectionData, SectionAdapter } from "./types";
const lists = ["permits", "violations", "inspections"] as const;
const ROW_FIELDS = ["number", "case", "type", "status", "date"];

/** Returns the L&I search URL; the address is normalized before it is encoded. */
const sourceUrl = (address: string) =>
  `https://li.phila.gov/property-history/search?address=${encodeURIComponent(address.toUpperCase())}`;
/** Returns bounded lists and counts, or null for malformed rows; unknown counts remain null. */
export function parseLiDeepResult(result: unknown): AgentSectionData | null {
  const obj = objectResult(result);
  if (!obj || !validStopFlags(obj) ||
    !optional(obj.page_url, ["string"]) || !optional(obj.truncated, ["boolean"])) return null;
  if (!Array.isArray(obj.permits) && obj.blocked !== true && obj.no_results !== true) return null;
  const raw = objectResult(obj.raw);
  if (obj.raw != null && !raw) return null;
  const output: AgentSectionData = { blocked: obj.blocked, no_results: obj.no_results, page_url: obj.page_url,
    licenses_listed: obj.licenses_listed };
  for (const name of lists) {
    const value = obj[name] ?? [];
    const rawCount = obj[`${name}_count`];
    if (!Array.isArray(value) || !optional(rawCount, ["number", "string"])) return null;
    const rows: AgentSectionData[] = [];
    for (const item of value.slice(0, DEEP_ROWS_MAX)) {
      const row = objectResult(item);
      if (!row || ROW_FIELDS.some((key) => !optional(row[key], ["string"]))) return null;
      rows.push({ ...row, date: dateValue(row.date), raw: { date: row.date ?? null } });
    }
    const count = numberValue(rawCount);
    output[name] = { count, rows, rows_returned: rows.length,
      truncated: obj.truncated === true || value.length > rows.length || (count !== null && rows.length < count),
      raw: { count: raw?.[`${name}_count`] ?? (rawCount == null ? null : String(rawCount)) } };
  }
  return output;
}
export const liDeepAdapter: SectionAdapter<AgentSectionData> = {
  id: "li_deep", label: "Permit and violation history", agency: "Department of Licenses & Inspections",
  method: "agent", monitorable: false,
  url: (ctx) => sourceUrl(ctx.address),
  goal: (ctx) => `${instructions(sourceUrl(ctx.address))} ` +
    `Return page_url, permits_count, violations_count, inspections_count, licenses_listed, truncated ` +
    `and raw with each count as shown, plus up to ${DEEP_ROWS_MAX} ` +
    "rows each of permits (number, type, status, date), violations (case, type, status, date), and inspections " +
    "(number, type, status, date). Return truncated: true if more rows exist or the page paginates; do not click pages.",
  outputSchema: schema({ page_url: { type: "string", nullable: true }, licenses_listed: { type: "boolean", nullable: true },
    truncated: { type: "boolean", nullable: true }, raw: { type: "object", nullable: true },
    ...Object.fromEntries(lists.flatMap((name) => [
      [`${name}_count`, { type: "integer", nullable: true }],
      [name, { type: "array", items: { type: "object", properties: Object.fromEntries(
        ROW_FIELDS.map((key) => [key, { type: "string", nullable: true }])) } }],
    ])) }),
  parseResult: parseLiDeepResult,
  classifyResult: (data) => {
    const read = lists.map((name) => data[name] as { count: number | null; rows_returned: number } | undefined);
    const rows = read.reduce((sum, list) => sum + (list?.rows_returned ?? 0), 0);
    const counted = read.some((list) => (list?.count ?? 0) > 0);
    // The page counted records and no row came back: the counts are known, the history was not read.
    if (data.blocked !== true && rows === 0 && counted) return { status: "unavailable", reason: "rows_not_read" };
    const nothingOnFile = rows === 0 && read.every((list) => list?.count === 0);
    return classify(data, nothingOnFile);
  },
};
