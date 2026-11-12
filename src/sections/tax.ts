// Real estate tax balance from the Philadelphia Tax Center.
import { classify, dateValue, instructions, numberValue, objectResult, optional, schema, streetAndUnit, validStopFlags } from "./agentCommon";
import type { AgentSectionData, SectionAdapter } from "./types";
const START_URL = "https://tax-services.phila.gov/_/";
/** Returns the balance and date with raw page text; delinquency is never inferred from the amount. */
export function parseTaxResult(result: unknown): AgentSectionData | null {
  const obj = objectResult(result);
  if (!obj || !validStopFlags(obj) ||
    !optional(obj.balance_usd, ["string", "number"]) || !optional(obj.delinquent, ["boolean"]) ||
    !optional(obj.as_of, ["string"])) return null;
  if (!("balance_usd" in obj) && obj.blocked !== true && obj.no_results !== true) return null;
  const raw = objectResult(obj.raw);
  if (obj.raw != null && !raw) return null;
  return { ...obj, balance_usd: numberValue(obj.balance_usd), delinquent: obj.delinquent ?? null,
    as_of: dateValue(obj.as_of), raw: { balance_usd: raw?.balance_usd ??
      (obj.balance_usd == null ? null : String(obj.balance_usd)), as_of: raw?.as_of ?? obj.as_of ?? null } };
}
export const taxAdapter: SectionAdapter<AgentSectionData> = {
  id: "tax", label: "Real estate tax", agency: "Department of Revenue", method: "agent", monitorable: false,
  url: () => START_URL,
  goal: (ctx) => {
    // The form finds a street, not a unit: a condominium unit is searched by its building and picked by its account.
    const { street, unit } = streetAndUnit(ctx.address);
    const open = unit === null
      ? "Open the first result and read the balance due."
      : `This property is unit ${unit} of a building with several units, so the search may list several properties: ` +
        `open the one whose account number is ${ctx.opa} or whose address ends with ${unit}, and read the balance due.`;
    return `${instructions(START_URL)} On the first page scroll down to the Property panel and click the link ` +
    `"Search for a property". The search form takes a street address: type ${street} and search. If the form ` +
    `has a field for an OPA or account number, use ${ctx.opa} there instead. ${open} ` +
    "Return blocked: true only for an access-denied, captcha or sign-in wall; a search that finds " +
    "nothing is no_results: true. " +
    "Return balance_usd as shown, delinquent only if explicitly stated (otherwise null), as_of as shown, and raw.";
  },
  outputSchema: schema({ balance_usd: { type: "string", nullable: true }, delinquent: { type: "boolean", nullable: true },
    as_of: { type: "string", nullable: true }, raw: { type: "object", nullable: true } }),
  parseResult: parseTaxResult,
  // A read that reached no balance, and did not say the search found nothing, stopped on the way
  // (3600 Market St unit 700, 12 November 2026: every step used before the result was opened).
  // That is a gap. It was stored as read, with a balance "not stated".
  classifyResult: (data) => data.blocked !== true && data.no_results !== true && data.balance_usd === null
    ? { status: "unavailable", reason: "balance_not_read" }
    : classify(data, false),
};
