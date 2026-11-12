// Catchment schools from the School District of Philadelphia finder.
import { classify, instructions, numberValue, objectResult, optional, schema, streetAndUnit, validStopFlags } from "./agentCommon";
import type { AgentSectionData, SectionAdapter } from "./types";
const START_URL = "https://webapps1.philasd.org/school_finder/";
/** Reads one school row or returns null; unknown distances remain null instead of being guessed. */
function readSchool(value: unknown): AgentSectionData | null {
  const row = objectResult(value);
  if (!row || typeof row.level !== "string" || typeof row.name !== "string" ||
    !optional(row.address, ["string"]) || !optional(row.distance_miles, ["string", "number"])) return null;
  return {
    ...row,
    distance_miles: numberValue(row.distance_miles),
    raw: { distance_miles: row.distance_miles == null ? null : String(row.distance_miles) },
  };
}

/** Returns school rows with distance and raw distance; malformed rows are unreadable. */
export function parseSchoolsResult(result: unknown): AgentSectionData | null {
  const obj = objectResult(result);
  if (!obj || !validStopFlags(obj)) return null;
  if (!Array.isArray(obj.catchment)) {
    return obj.catchment == null && (obj.blocked === true || obj.no_results === true) ? { ...obj, catchment: [] } : null;
  }
  const catchment = [];
  for (const value of obj.catchment) {
    const row = readSchool(value);
    if (!row) return null;
    catchment.push(row);
  }
  return { ...obj, catchment };
}
export const schoolsAdapter: SectionAdapter<AgentSectionData> = {
  id: "schools", label: "Catchment schools", agency: "School District of Philadelphia", method: "agent", monitorable: false,
  url: () => START_URL,
  // A catchment is drawn by street, so a condominium unit is searched by its building's address.
  goal: (ctx) => `${instructions(START_URL)} Search for ${streetAndUnit(ctx.address).street}. Return catchment rows with level, name, address ` +
    "and distance_miles as shown (null when absent).",
  outputSchema: schema({ catchment: { type: "array", items: { type: "object", properties: {
    level: { type: "string" }, name: { type: "string" }, address: { type: "string", nullable: true },
    distance_miles: { type: "string", nullable: true },
  } } } }),
  parseResult: parseSchoolsResult, classifyResult: (data) => classify(data, (data.catchment as unknown[]).length === 0),
};
