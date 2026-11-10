// Assessment history from the OPA valuation table.
import { classify, instructions, numberValue, objectResult, optional, schema, validStopFlags } from "./agentCommon";
import type { AgentSectionData, SectionAdapter } from "./types";

const fields = ["year", "market_value", "taxable_land", "taxable_improvement", "exempt_land", "exempt_improvement"];
/** Returns parsed valuation rows, or null for malformed output; missing page values remain null with their raw strings. */
export function parseAssessmentResult(result: unknown): AgentSectionData | null {
  const obj = objectResult(result);
  if (!obj || !validStopFlags(obj)) return null;
  if (!Array.isArray(obj.years)) {
    return obj.years == null && (obj.blocked === true || obj.no_results === true) ? { ...obj, years: [] } : null;
  }
  const years = [];
  for (const value of obj.years) {
    const row = objectResult(value);
    if (!row || fields.some((key) => !optional(row[key], ["number", "string"]))) return null;
    // A row with nothing in it is not a row of the table: the run found the table and read no cell.
    if (fields.every((key) => row[key] == null || String(row[key]).trim() === "")) continue;
    const raw = Object.fromEntries(fields.map((key) => [key, row[key] == null ? null : String(row[key])]));
    years.push({ year: numberValue(row.year), market_value_usd: numberValue(row.market_value),
      taxable_land_usd: numberValue(row.taxable_land), taxable_improvement_usd: numberValue(row.taxable_improvement),
      exempt_land_usd: numberValue(row.exempt_land), exempt_improvement_usd: numberValue(row.exempt_improvement), raw });
  }
  // Rows were returned and none held a value: the table was not read, which is not the same as empty.
  if (obj.years.length > 0 && years.length === 0) return null;
  return { ...obj, years };
}
export const assessmentHistoryAdapter: SectionAdapter<AgentSectionData> = {
  id: "assessment_history", label: "Assessment history", agency: "Office of Property Assessment", method: "agent",
  monitorable: false,
  url: (ctx) => `https://property.phila.gov/?p=${encodeURIComponent(ctx.opa)}`,
  goal: (ctx) => `${instructions(`https://property.phila.gov/?p=${encodeURIComponent(ctx.opa)}`)} ` +
    "The page fills its tables a few seconds after it opens: wait 5 seconds before reading anything. " +
    "Then scroll down to the Valuation History table. Its rows arrive a few seconds after the page: wait until the first " +
    "row shows a four-digit year and dollar amounts, and if the cells are still empty wait and look again. " +
    "The first column of every row is the tax year, four digits such as 2026: return it as year. Return years, " +
    "one for each row, each with year, market_value, taxable_land, taxable_improvement, exempt_land and " +
    "exempt_improvement as shown on screen. Never return a row whose cells you could not read.",
  outputSchema: schema({ years: { type: "array", items: { type: "object", properties:
    Object.fromEntries(fields.map((key) => [key, { type: "string", nullable: true }])) } } }),
  parseResult: parseAssessmentResult,
  classifyResult: (data) => classify(data, (data.years as unknown[]).length === 0),
};
