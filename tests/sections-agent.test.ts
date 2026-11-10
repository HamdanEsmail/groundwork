// Tests the Agent adapters with recorded and hand-built results.
import { describe, expect, it } from "vitest";
import { assessmentHistoryAdapter } from "../src/sections/assessmentHistory";
import { taxAdapter } from "../src/sections/tax";
import { schoolsAdapter } from "../src/sections/schools";
import { floodAdapter } from "../src/sections/flood";
import { liDeepAdapter } from "../src/sections/liDeep";
import { dateValue } from "../src/sections/agentCommon";
import noResults from "./fixtures/agent/fema-noresults.json";
import blocked from "./fixtures/agent/fema-blocked.json";
import deep from "./fixtures/agent/li-deep.json";
import assessment from "./fixtures/agent/assessment-history.json";
import tax from "./fixtures/agent/tax.json";
import schools from "./fixtures/agent/schools.json";

const reason = "FEMA's map search returned no results in an automated browser";
const examples = [
  [assessmentHistoryAdapter, assessment],
  [taxAdapter, tax],
  [schoolsAdapter, schools],
  [liDeepAdapter, deep.result],
] as const;

describe("Agent adapters", () => {
  it.each(examples)("reads and classifies a result", (adapter, result) => {
    const data = adapter.parseResult!(result);
    expect(data).not.toBeNull();
    expect(adapter.classifyResult!(data!)).toEqual({ status: "ok" });
    expect(adapter.parseResult!("junk")).toBeNull();
    expect(adapter.classifyResult!(adapter.parseResult!({ blocked: true })!)).toMatchObject({ status: "unavailable" });
  });
  it.each([assessmentHistoryAdapter, schoolsAdapter])("classifies an empty search", (adapter) => {
    expect(adapter.classifyResult!(adapter.parseResult!({ no_results: true })!)).toEqual({ status: "empty" });
  });
  it.each([noResults, blocked])("reports the recorded FEMA search honestly", (fixture) => {
    const data = floodAdapter.parseResult!(fixture.result);
    expect(data).not.toBeNull();
    expect(floodAdapter.classifyResult!(data!)).toEqual({ status: "unavailable", reason });
  });
  it.each(["Not found", "No results", "Unknown", "", "   "])(
    "classifies the FEMA non-zone value %j as unavailable",
    (flood_zone) => {
      const data = floodAdapter.parseResult!({ flood_zone });
      expect(floodAdapter.classifyResult!(data!)).toEqual({ status: "unavailable", reason });
    },
  );
  it("rejects unreadable FEMA output", () => expect(floodAdapter.parseResult!("junk")).toBeNull());
  it.each([
    ["11/03/2026", "2026-11-03"],
    ["2026-11-03", "2026-11-03"],
    ["2026-11-03T22:15:00-05:00", "2026-11-03"],
    ["November 3, 2026", "2026-11-03"],
    ["Nov 3, 2026", "2026-11-03"],
    ["Sept. 5, 2025", "2025-09-05"],
    ["3 November 2026", "2026-11-03"],
    ["3rd Nov 2026", "2026-11-03"],
  ])("reads the full date %j as %s", (text, iso) => {
    expect(dateValue(text)).toBe(iso);
  });
  it.each(["2026", "Nov 2026", "November 2026", "Q3 2026", "Monday", "11/2026", "February 30, 2026", "2026-13-01", "Nov 3", "", "   ", null, 20261103])(
    "reads no day into %j: a date that is not a full date is not a date",
    (text) => {
      expect(dateValue(text)).toBeNull();
    },
  );
  it("keeps the page's own words beside a date it will not guess", () => {
    expect(taxAdapter.parseResult!({ balance_usd: "$10.50", delinquent: false, as_of: "2026" })).toMatchObject({
      as_of: null,
      raw: { as_of: "2026" },
    });
    expect(floodAdapter.parseResult!({ flood_zone: "X", effective_date: "Nov 2026" })).toMatchObject({
      effective_date: null,
      raw: { effective_date: "Nov 2026" },
    });
  });
  it("does not call a valuation table read when every row came back empty", () => {
    const blank = { year: null, market_value: null, taxable_land: null, taxable_improvement: null,
      exempt_land: null, exempt_improvement: null };
    // What the live run for 1234 Market St returned: one row, nothing in it.
    expect(assessmentHistoryAdapter.parseResult!({ years: [blank], blocked: false, no_results: false })).toBeNull();
    // A blank row beside real ones is dropped; the real ones stay.
    const mixed = assessmentHistoryAdapter.parseResult!({ years: [{ ...blank, year: "2026", market_value: "$1,524,100" }, blank] });
    expect(mixed!.years).toHaveLength(1);
    expect(mixed!.years).toMatchObject([{ year: 2026, market_value_usd: 1524100 }]);
    expect(assessmentHistoryAdapter.classifyResult!(mixed!)).toEqual({ status: "ok" });
  });
  it("asks for the tax year of every valuation row", () => {
    const goal = assessmentHistoryAdapter.goal!({ address: "1 EXAMPLE ST", opa: "111111111" });
    expect(goal).toMatch(/first column[^.]*year/i);
    expect(goal).toMatch(/scroll/i);
    // The rows arrive after the page: a read taken at once returned rows with nothing in them.
    expect(goal).toMatch(/wait until the first row shows/i);
    // Three live runs read the table the moment the page opened and got rows of empty cells.
    expect(goal).toMatch(/wait 5 seconds before reading anything/i);
    expect(goal).toMatch(/never return a row/i);
  });
  it("searches FEMA with the city and state, since its search covers the whole country", () => {
    const ctx = { address: "1 EXAMPLE ST", opa: "111111111" };
    expect(floodAdapter.goal!(ctx)).toContain("Search for 1 EXAMPLE ST, Philadelphia, PA");
    expect(floodAdapter.manualUrl!(ctx)).toBe(
      "https://msc.fema.gov/portal/search?AddressQuery=1%20EXAMPLE%20ST%2C%20Philadelphia%2C%20PA");
  });
  it("does not call the permit history read when the page's counts came back and no row did", () => {
    // What the live run for 1234 Market St returned: 155 permits and 83 violations counted, no rows.
    const counted = liDeepAdapter.parseResult!({ page_url: "https://li.phila.gov/property-history/search?address=1%20EXAMPLE%20ST",
      permits_count: 155, violations_count: 83, inspections_count: null, permits: [], violations: [], inspections: [], truncated: true });
    expect(liDeepAdapter.classifyResult!(counted!)).toEqual({ status: "unavailable", reason: "rows_not_read" });
    // A property with nothing on file is a read, and an empty one.
    const none = liDeepAdapter.parseResult!({ permits_count: 0, violations_count: 0, inspections_count: 0, permits: [], violations: [], inspections: [] });
    expect(liDeepAdapter.classifyResult!(none!)).toEqual({ status: "empty" });
    expect(liDeepAdapter.classifyResult!(liDeepAdapter.parseResult!(deep.result)!)).toEqual({ status: "ok" });
  });
  it("tells the tax search which field takes what, and that running out of steps is not a refusal", () => {
    const goal = taxAdapter.goal!({ address: "1 EXAMPLE ST", opa: "111111111" });
    expect(goal).toContain("Search for a property");
    expect(goal).toContain("1 EXAMPLE ST");
    expect(goal).toContain("111111111");
    expect(goal).toMatch(/blocked: true only/i);
  });
  it("keeps original values and parses dates and numbers", () => {
    expect(taxAdapter.parseResult!(examples[1][1])).toMatchObject({ balance_usd: 10.5, as_of: "2025-01-02",
      raw: { balance_usd: "$10.50", as_of: "01/02/2025" } });
    expect(liDeepAdapter.parseResult!(deep.result)).toMatchObject({ permits: { count: 155, rows_returned: 5,
      truncated: true } });
  });
});
