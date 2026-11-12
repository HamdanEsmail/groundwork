// Pages as the atlas served them on 12 November 2026 for an ordinary row house, 2314 Brown St,
// and what the paid searches are told for a condominium unit. Both came out of an outside test
// of the live site.
import { describe, expect, it } from "vitest";
import { gapReason } from "../src/dossier/reasons";
import { parseLi } from "../src/sections/li";
import { parseProperty } from "../src/sections/property";
import { schoolsAdapter } from "../src/sections/schools";
import { taxAdapter } from "../src/sections/tax";

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fx(name: string): string {
  const text = fixtures[`./fixtures/atlas/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}
function must<T>(value: T | null): T {
  if (value === null) throw new Error("the page was not recognised");
  return value;
}

describe("a licences page that came without its address heading", () => {
  it("is read: its counted lists and its parcel address say what page it is", () => {
    const data = must(parseLi(fx("li-2314-brown.md")));
    expect(data.buildings_count).toBe(1);
    expect(data.buildings[0]).toMatchObject({ building_id: "1064484", parcel_address: "2314 BROWN ST", height_ft: 30, footprint_sqft: 831 });
    expect(data.permits).toMatchObject({ count: 0, recent: [], all_url: "https://li.phila.gov/property-history/search?address=2314%20BROWN%20ST" });
    expect(data.certifications).toEqual({ count: 0, recent: [] });
    expect(data.violations).toMatchObject({ count: 1, open_count: 0, open_count_of: 1 });
    expect(data.violations.recent[0]).toMatchObject({ date: "2019-11-15", description: "ONE AND TWO FAMILY (R3)", status: "COMPLIED" });
    expect(data.inspections.count).toBe(4);
    expect(data.inspections.recent).toHaveLength(4);
    expect(data.zoning_documents.count).toBe(1);
    expect(data.appeals).toEqual({ count: 0, recent: [] });
    expect(data.business_licenses.recent.map((r) => r.name)).toEqual(["K&R Group LLC", "2314 Brown Street"]);
  });

  it("is still refused when it has neither a heading nor a parcel address", () => {
    expect(parseLi("Licenses and inspections.\n\n## Permits (0)\n\n## Violations (0)\n")).toBeNull();
  });
});

describe("a build year the city marks as estimated", () => {
  it("is kept as the year, and marked", () => {
    const data = must(parseProperty(fx("property-2314-brown.md")));
    expect(data.year_built).toBe(1920);
    expect(data.year_built_estimated).toBe(true);
    expect(data.raw.year_built).toBe("1920 (estimated)");
  });

  it("is not marked on a year the city states plainly", () => {
    const data = must(parseProperty(fx("property-1234-market.md")));
    expect(data.year_built).toBeGreaterThan(1800);
    expect(data.year_built_estimated).toBeUndefined();
  });
});

describe("what the paid searches are told for a condominium unit", () => {
  const unit = { address: "3600 MARKET ST STE 700", opa: "883076625" };

  it("searches the school finder by the building's street, without the unit", () => {
    const goal = schoolsAdapter.goal!(unit);
    expect(goal).toContain("Search for 3600 MARKET ST.");
    expect(goal).not.toContain("STE 700");
  });

  it("searches the tax centre by the building's street and picks the unit by its account", () => {
    const goal = taxAdapter.goal!(unit);
    expect(goal).toContain("type 3600 MARKET ST and search");
    expect(goal).not.toContain("type 3600 MARKET ST STE 700");
    expect(goal).toContain("883076625");
    expect(goal).toContain("unit 700");
  });

  it("takes a unit written with a number sign", () => {
    expect(schoolsAdapter.goal!({ address: "3600 MARKET ST # 400", opa: "883076685" })).toContain("Search for 3600 MARKET ST.");
  });

  it("leaves an ordinary address as it is", () => {
    const house = { address: "1234 MARKET ST", opa: "883309050" };
    expect(schoolsAdapter.goal!(house)).toContain("Search for 1234 MARKET ST.");
    expect(taxAdapter.goal!(house)).toContain("type 1234 MARKET ST and search");
    expect(taxAdapter.goal!(house)).not.toContain("unit");
  });
});

describe("a tax read that stopped before it reached a balance", () => {
  // What the tax search returned for 3600 Market St unit 700 on 12 November 2026, all its steps used.
  const unfinished = {
    raw: { balance_usd: null, as_of: null },
    as_of: null,
    blocked: false,
    delinquent: null,
    no_results: false,
    balance_usd: null,
    error_message: "Budget exhausted before completing task.",
  };

  it("is a gap, not a read", () => {
    const data = must(taxAdapter.parseResult!(unfinished));
    expect(taxAdapter.classifyResult!(data)).toEqual({ status: "unavailable", reason: "balance_not_read" });
  });

  it("is still a read when the balance is there, and still nothing found when the search says so", () => {
    expect(taxAdapter.classifyResult!(must(taxAdapter.parseResult!({ balance_usd: "$0.00", delinquent: null, as_of: null })))).toEqual({ status: "ok" });
    expect(taxAdapter.classifyResult!(must(taxAdapter.parseResult!({ no_results: true })))).toEqual({ status: "empty" });
  });

  it("says why in plain words", () => {
    // A visitor has no way to start that read again, so the sentence does not promise one.
    expect(gapReason("balance_not_read")).toBe("The search page was reached, but the read stopped before it got to a balance.");
  });
});

describe("ordinary addresses reach the paid searches as the city writes them", () => {
  it.each(["1234 MARKET ST", "5600 GERMANTOWN AVE", "4001 WALNUT ST", "1500-42 MARKET ST", "1500S MARKET ST", "2314 BROWN ST"])("%s", (address) => {
    expect(schoolsAdapter.goal!({ address, opa: "111111111" })).toContain(`Search for ${address}.`);
    expect(taxAdapter.goal!({ address, opa: "111111111" })).toContain(`type ${address} and search`);
  });
});
