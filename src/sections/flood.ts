// FEMA flood search, preserving unavailable results and the manual search link.
import { dateValue, instructions, objectResult, optional, schema, validStopFlags } from "./agentCommon";
import type { AgentSectionData, SectionAdapter } from "./types";
const START_URL = "https://msc.fema.gov/portal/search";
const FIELDS = ["flood_zone", "firm_panel", "effective_date", "results_url"];
const REASON = "FEMA's map search returned no results in an automated browser";
/** FEMA's search covers the whole country, so a street line alone finds nothing: the city and state go with it. */
const place = (address: string) => `${address}, Philadelphia, PA`;
// Whether to enable an NFHL viewer probe remains open; use the recorded search outcome in the meantime.
/** Returns a readable FEMA result with its raw date; blocked and no-result responses are valid results. */
export function parseFloodResult(result: unknown): AgentSectionData | null {
  const obj = objectResult(result);
  if (!obj || !validStopFlags(obj) ||
    FIELDS.some((key) => !optional(obj[key], ["string"]))) return null;
  if (!("flood_zone" in obj) && obj.blocked !== true && obj.no_results !== true) return null;
  return { ...obj, effective_date: dateValue(obj.effective_date), raw: { effective_date: obj.effective_date ?? null } };
}
export const floodAdapter: SectionAdapter<AgentSectionData> = {
  id: "flood", label: "Flood zone", agency: "FEMA", method: "agent", monitorable: false, url: () => START_URL,
  // Four runs in a row (two while designing, two live) used every step they were given and found
  // nothing. Six steps are enough to type the address, search and look; the rest was money for no answer.
  maxSteps: 6,
  manualUrl: (ctx) => `${START_URL}?AddressQuery=${encodeURIComponent(place(ctx.address))}`,
  goal: (ctx) => `${instructions(START_URL)} Search for ${place(ctx.address)}. Return flood_zone, firm_panel, effective_date ` +
    "as shown and results_url; report no_results when there are no results.",
  outputSchema: schema(Object.fromEntries(FIELDS.map((key) =>
    [key, { type: "string", nullable: true }]))),
  parseResult: parseFloodResult,
  classifyResult: (data) => data.blocked !== true && data.no_results !== true && typeof data.flood_zone === "string" &&
    data.flood_zone.trim() !== "" && !/not found|no results|unknown/i.test(data.flood_zone)
    ? { status: "ok" } : { status: "unavailable", reason: REASON },
};
