import { describe, expect, it } from "vitest";
import { parseCondoUnits } from "../src/address/resolve";
import { deedsAdapter, parseDeeds as readDeeds } from "../src/sections/deeds";
import {
  DEEP_SECTION_ID,
  FREE_SECTION_IDS,
  SECTIONS,
  STANDARD_AGENT_SECTION_IDS,
  getSection,
  manualUrlFor,
} from "../src/sections/index";
import { diffLi, liAdapter, parseLi as readLi } from "../src/sections/li";
import { isSeparatorRow, keyValues, records, splitSections, tableCells, usd, usDate } from "../src/sections/markdown";
import { diffProperty, parseProperty as readProperty, propertyAdapter } from "../src/sections/property";
import type { Depth, LicensesInspectionsData, PropertyData, SectionAdapter } from "../src/sections/types";
import { parseZoning as readZoning, zoningAdapter } from "../src/sections/zoning";
import { isIncomplete } from "../src/tinyfish/fetch";

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fx(name: string): string {
  const text = fixtures[`./fixtures/atlas/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}

const CTX = { address: "1234 MARKET ST", opa: "883309050" };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// The parsers return null for a page that is not a read of their tab; most tests want the data.
function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected the page to be recognised");
  return value;
}
const parseProperty = (md: string) => must(readProperty(md));
const parseLi = (md: string) => must(readLi(md));
const parseZoning = (md: string) => must(readZoning(md));
const parseDeeds = (md: string) => must(readDeeds(md));

describe("markdown helpers", () => {
  it("splits a table line into trimmed cells and recognises separator rows", () => {
    expect(tableCells("| 09/15/2026 | EP-2026-004102 | Electrical Permit | Issued |")).toEqual([
      "09/15/2026",
      "EP-2026-004102",
      "Electrical Permit",
      "Issued",
    ]);
    expect(tableCells("|  |  |")).toEqual(["", ""]);
    expect(tableCells("See all permits at L&I Property History")).toBeNull();
    expect(isSeparatorRow(["---", ":---:", "---:"])).toBe(true);
    expect(isSeparatorRow(["Date", "---"])).toBe(false);
  });

  it("splits cells on unescaped pipes only and drops markdown backslash escapes from the text", () => {
    // 1900 Chestnut St: the city's building description is "DOWNTOWN ROW TYPE-\* SNGL OCCP" in the markdown
    expect(tableCells(String.raw`| DOWNTOWN ROW TYPE-\* SNGL OCCP | a \| b | back\\slash |`)).toEqual([
      "DOWNTOWN ROW TYPE-* SNGL OCCP",
      "a | b",
      String.raw`back\slash`,
    ]);
    expect(tableCells(String.raw`| 100 \| 200 |`)).toEqual(["100 | 200"]);
    // a backslash before a letter is not an escape
    expect(tableCells(String.raw`| C:\temp |`)).toEqual([String.raw`C:\temp`]);
  });

  it("puts a row back in its columns when the page left its first cell empty", () => {
    // 4001 Walnut St on the live atlas: two certification rows have no inspection type, and the
    // empty cell does not survive, so the row arrives one cell short and every value sat one column left.
    const columns = ["Inspection Type", "Date Inspected", "Inspection Result", "Expiration Date"];
    const section = splitSections("## Building Certifications (3)\n\n| Inspection Type | Date Inspected | Inspection Result | Expiration Date |\n| --- | --- | --- | --- |\n" +
      "| Facade Report | 03/04/2025 | Safe with Repair | 03/04/2030 |\n| 01/16/2026 | Certified | 01/16/2027 |\n").sections[0];
    expect(records(section, columns)).toEqual([
      { "Inspection Type": "Facade Report", "Date Inspected": "03/04/2025", "Inspection Result": "Safe with Repair", "Expiration Date": "03/04/2030" },
      { "Inspection Type": "", "Date Inspected": "01/16/2026", "Inspection Result": "Certified", "Expiration Date": "01/16/2027" },
    ]);
    // A short row in a table whose first column is a date is left as it came: nothing says which cell is missing.
    const permits = splitSections("## Permits (1)\n\n| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| 05/01/2026 | A-1 | Issued |\n").sections[0];
    expect(records(permits, ["Date", "ID", "Description", "Status"])[0]).toMatchObject({ Date: "05/01/2026", ID: "A-1", Description: "Issued", Status: "" });
  });

  it("reads a one-cell Loading row as a message, not a record", () => {
    const columns = ["Date", "ID", "Description", "Status"];
    const section = splitSections("## Permits (3)\n\n| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| Loading permits... |\n").sections[0];
    expect(records(section, columns)).toEqual([]);
    const filled = splitSections("## Permits (3)\n\n| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| 05/01/2026 | A-1 | LOADING DOCK | Issued |\n").sections[0];
    expect(records(filled, columns)).toHaveLength(1);
  });

  it("splits a page into '## Name (N)' sections with their tables", () => {
    const page = splitSections(fx("li-1234-market.md"));
    expect(page.sections.map((s) => [s.title, s.count])).toEqual([
      ["Building Certifications", 12],
      ["Permits", 155],
      ["Zoning Permit Documents", 7],
      ["Inspections", 99],
      ["Violations", 83],
      ["L&I Appeals", 3],
      ["Business Licenses", 13],
    ]);
    const permits = page.sections[1]!.tables[0]!;
    expect(permits.columns).toEqual(["Date", "ID", "Description", "Status"]);
    expect(permits.rows).toHaveLength(5);
    // the building table sits above the first "##" header
    expect(keyValues(page.preamble.tables[0]!)["Building ID"]).toBe("1530931");
  });

  it("reads a title that itself holds parentheses before the count", () => {
    const page = splitSections(fx("zoning-1234-market.md"));
    expect(page.sections.map((s) => [s.title, s.count])).toContainEqual(["Registered Community Organizations (RCOs)", 3]);
    expect(splitSections(fx("deeds-1234-market.md")).sections.map((s) => [s.title, s.count])).toEqual([
      ["Parcel Details", null],
      ["Documents", 36],
      ["Registry Maps", null],
    ]);
  });

  it("leaves the moved cell helpers' callers unchanged", () => {
    expect(parseCondoUnits(fx("condos-1500-market.md"))).toHaveLength(2);
    expect(isIncomplete(fx("li-loading.md"))).toBe(true);
  });

  it("reads dollar amounts with or without a $ or USD prefix, and US or ISO dates", () => {
    expect(usd("$148,232,900")).toBe(148232900);
    expect(usd("148,232,900")).toBe(148232900);
    expect(usd("USD 148,232,900")).toBe(148232900);
    expect(usd("$148,232,900.00")).toBe(148232900);
    expect(usd("not a number")).toBeNull();
    expect(usDate("09/17/1993")).toBe("1993-09-17");
    expect(usDate("1993-09-17")).toBe("1993-09-17");
    expect(usDate("To Be Determined")).toBeNull();
  });
});

describe("new fixtures are complete reads", () => {
  it.each(["zoning-1234-market.md", "deeds-1234-market.md", "li-1234-market-changed.md", "li-1234-market-reordered.md"])(
    "%s is not flagged incomplete",
    (name) => {
      expect(isIncomplete(fx(name))).toBe(false);
    },
  );
});

describe("hand-edited li fixtures", () => {
  const lines = (name: string) => fx(name).split("\n");
  const only = (x: string[], y: string[]) => x.filter((l) => !y.includes(l));

  it("the changed read differs from li-1234-market.md by exactly two edits", () => {
    const original = lines("li-1234-market.md");
    const changed = lines("li-1234-market-changed.md");
    expect(changed).toHaveLength(original.length);
    expect(only(original, changed)).toEqual([
      "## Permits (155)",
      "| 02/04/2026 | CP-2025-006422 | Commercial Building Permit | Completed |",
      "| 10/19/2026 | CF-2026-141191 | WET CHEMICAL SYSTEM TEST | OPEN |",
    ]);
    expect(only(changed, original)).toEqual([
      "## Permits (156)",
      "| 10/30/2026 | EP-2026-009999 | Electrical Permit | Issued |",
      "| 10/19/2026 | CF-2026-141191 | WET CHEMICAL SYSTEM TEST | CLOSED |",
    ]);
  });

  it("the reordered read holds the same lines; text, column rows and separators stay where they were", () => {
    const original = lines("li-1234-market.md");
    const reordered = lines("li-1234-market-reordered.md");
    expect(reordered).not.toEqual(original);
    expect([...reordered].sort()).toEqual([...original].sort());
    original.forEach((line, i) => {
      const isSeparator = line.startsWith("| --- ");
      if (!line.startsWith("|") || isSeparator || original[i + 1]?.startsWith("| --- ")) expect(reordered[i]).toBe(line);
    });
  });
});

describe("property.parse", () => {
  it("reads 1234 Market St", () => {
    const data = parseProperty(fx("property-1234-market.md"));
    expect(data).toEqual({
      opa_account: "883309050",
      opa_address: "1234 MARKET ST",
      owners: ["SEPTA"],
      mailing_address: ["Us Equities Mgt Llc", "Bldg Mgt Office", "1234 Market St", "Philadelphia, PA 19107"],
      building_description: "OFFICE BLDNG - High Rise",
      year_built: 1973,
      improvement_area_sqft: 723780,
      assessed_value_usd: 148232900,
      homestead: false,
      sale_date: "1993-09-17",
      sale_price_usd: 10,
      units_notice: null,
      raw: {
        owners: "SEPTA",
        mailing_address: "Us Equities Mgt Llc   Bldg Mgt Office   1234 Market St   Philadelphia, PA 19107",
        year_built: "1973",
        improvement_area_sqft: "723,780 sq ft",
        assessed_value_usd: "$148,232,900",
        homestead: "This property does not have the homestead exemption",
        sale_date: "09/17/1993",
        sale_price_usd: "$10",
      },
    } satisfies PropertyData);
  });

  it("reads an assessed value without a dollar sign and an ISO sale date, keeping the page's own text", () => {
    const text = fx("property-1234-market.md")
      .replace("$148,232,900", "148,232,900")
      .replace("09/17/1993", "1993-09-17");
    const data = parseProperty(text);
    expect(data.assessed_value_usd).toBe(148232900);
    expect(data.raw.assessed_value_usd).toContain("148,232,900");
    expect(data.sale_date).toBe("1993-09-17");
    expect(data.raw.sale_date).toBe("1993-09-17");
  });

  it("reads the 1500 Market St condominium parent", () => {
    const data = parseProperty(fx("property-1500-market.md"));
    expect(data.opa_account).toBe("883320000");
    expect(data.opa_address).toBe("1500-42 MARKET ST");
    expect(data.owners).toEqual(["NG 1500 MARKET ST LLC"]);
    expect(data.sale_date).toBe("2017-07-14");
    expect(data.sale_price_usd).toBe(328000000);
    expect(data.raw.sale_price_usd).toBe("$328,000,000");
    expect(data.assessed_value_usd).toBe(107000000);
    expect(data.improvement_area_sqft).toBe(2215276);
    expect(data.year_built).toBe(1974);
    expect(data.units_notice).toBe(2);
  });

  it("reads a page whose building fields are 'Not Available' (OPA 875100060)", () => {
    const data = parseProperty(fx("property-opa-875100060.md"));
    expect(data).toMatchObject({
      opa_account: "875100060",
      opa_address: "1500S MARKET ST",
      owners: ["SEPTA"],
      mailing_address: ["1234 Market St", "Philadelphia, PA 19107"],
      building_description: "Not Available",
      year_built: null,
      improvement_area_sqft: null,
      assessed_value_usd: 459300,
      sale_date: "1968-09-27",
      sale_price_usd: 9,
      units_notice: null,
    });
    expect(data.raw.year_built).toBe("Not Available");
    expect(data.raw.improvement_area_sqft).toBe("Not Available");
  });

  it("splits several owners on runs of spaces and reads the homestead sentence both ways", () => {
    const page = (owners: string, homestead: string) =>
      `# 1 TEST ST\n\n|  |  |\n| --- | --- |\n| OPA Account # | 123456789 |\n| Owners | ${owners} |\n| Homestead Exemption | ${homestead} |\n`;
    const two = parseProperty(page("SMITH JOHN   SMITH MARY", "This property has the homestead exemption  Learn about property tax programs"));
    expect(two.owners).toEqual(["SMITH JOHN", "SMITH MARY"]);
    expect(two.homestead).toBe(true);
    expect(parseProperty(page("A", "Something else")).homestead).toBeNull();
    const sparse = parseProperty("# 1 TEST ST\n\n|  |  |\n| --- | --- |\n| OPA Account # | 123456789 |\n");
    expect(sparse.owners).toEqual([]);
    expect(sparse.assessed_value_usd).toBeNull();
    expect(sparse.raw.assessed_value_usd).toBeNull();
  });

  it("reads markdown escapes as the city's text, in the value and in raw", () => {
    const page =
      "# 1900 CHESTNUT ST\n\n|  |  |\n| --- | --- |\n| OPA Account # | 123456789 |\n" +
      String.raw`| Owners | SMITH \* JONES LLC |
| Building Description | DOWNTOWN ROW TYPE-\* SNGL OCCP |
`;
    const data = parseProperty(page);
    expect(data.building_description).toBe("DOWNTOWN ROW TYPE-* SNGL OCCP");
    expect(data.owners).toEqual(["SMITH * JONES LLC"]);
    expect(data.raw.owners).toBe("SMITH * JONES LLC");
  });

  it("keeps a city string it cannot parse as raw with a null value", () => {
    const data = parseProperty(
      "# 1 TEST ST\n\n|  |  |\n| --- | --- |\n| OPA Account # | 123456789 |\n| Year Built | Unknown |\n| Sale Date | 13/45/2020 |\n| Assessed Value | n/a View tax balance & pay bill |\n",
    );
    expect(data.year_built).toBeNull();
    expect(data.raw.year_built).toBe("Unknown");
    expect(data.sale_date).toBeNull();
    expect(data.raw.sale_date).toBe("13/45/2020");
    expect(data.assessed_value_usd).toBeNull();
    expect(data.raw.assessed_value_usd).toBe("n/a");
  });
});

describe("parse returns null for a page that is not a read of its tab", () => {
  const readers = { property: readProperty, li: readLi, zoning: readZoning, deeds: readDeeds };
  const all = (md: string) => Object.fromEntries(Object.entries(readers).map(([k, read]) => [k, read(md)]));
  const none = { property: null, li: null, zoning: null, deeds: null };

  it.each(["shell-condominiums.md", "shell-licenses-inspections.md", "property-no-record.md", "li-loading.md"])("%s is nobody's tab", (name) => {
    expect(all(fx(name))).toEqual(none);
  });

  it("empty text and a heading alone are not a read", () => {
    expect(all("")).toEqual(none);
    expect(all("# 1234 MARKET ST\n\nPHILADELPHIA, PA 19107-3721\n")).toEqual(none);
  });

  it("each tab's page is a read of its own tab and of no other", () => {
    const own = { property: "property-1234-market.md", li: "li-1234-market.md", zoning: "zoning-1234-market.md", deeds: "deeds-1234-market.md" };
    for (const [tab, name] of Object.entries(own)) {
      const result = all(fx(name));
      expect(Object.entries(result).filter(([, v]) => v !== null).map(([k]) => k)).toEqual([tab]);
    }
  });

  it("the recorded pages that held their anchors are reads (the two condominium and OPA 875100060 property pages too)", () => {
    for (const name of ["property-1500-market.md", "property-opa-875100060.md"]) expect(readProperty(fx(name))).not.toBeNull();
    for (const name of ["li-1234-market-changed.md", "li-1234-market-reordered.md"]) expect(readLi(fx(name))).not.toBeNull();
  });

  it("a page whose expected column is renamed is not a read: no '' values, no collapsed ids", () => {
    const li = fx("li-1234-market.md");
    expect(readLi(li.replace("| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| 10/19/2026 | CF-2026-141276 | PERIODIC", "| Date | ID | Description | State |\n| --- | --- | --- | --- |\n| 10/19/2026 | CF-2026-141276 | PERIODIC"))).toBeNull();
    expect(readLi(li.replace("| Inspection Type |", "| Type of Inspection |"))).toBeNull();
    expect(readLi(li.replace("| Date | Appeal Number |", "| Date | Appeal No |"))).toBeNull();
    expect(readZoning(fx("zoning-1234-market.md").replace("| Name | Code Section | Show Overlay |", "| Name | Section | Show Overlay |"))).toBeNull();
    expect(readDeeds(fx("deeds-1234-market.md").replace("| Grantor |", "| From |"))).toBeNull();
    expect(readProperty(fx("property-1234-market.md").replace("| OPA Account # |", "| Account # |"))).toBeNull();
  });

  it("a table without its separator row is not read as rows", () => {
    const li = fx("li-1234-market.md");
    expect(readLi(li.replace("| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| 09/15/2026", "| Date | ID | Description | Status |\n| 09/15/2026"))).toBeNull();
  });

  it("a counted list with no table is not a complete read", () => {
    expect(readLi(fx("li-1234-market.md").replace(/## Violations \(83\)\n\n(\|.*\n)+/, "## Violations (83)\n\n"))).toBeNull();
  });

  it("the page that served a read of one tab but with the markers missing is not a read", () => {
    expect(readZoning(fx("zoning-1234-market.md").replace("**Base District**", "**District**"))).toBeNull();
    expect(readDeeds(fx("deeds-1234-market.md").replace("## Parcel Details", "## Parcel Info"))).toBeNull();
    expect(readLi(fx("li-1234-market.md").replace("## Permits (155)", "## Permits"))).toBeNull();
    expect(readLi(fx("li-1234-market.md").replace("# 1234 MARKET ST\n", ""))).toBeNull();
  });
});

describe("property.diff", () => {
  const before = parseProperty(fx("property-1234-market.md"));

  it("yields nothing for the same page", () => {
    expect(diffProperty(before, parseProperty(fx("property-1234-market.md")))).toEqual([]);
  });

  it("yields assessment_change with the values and the city's strings", () => {
    const after = clone(before);
    after.assessed_value_usd = 150000000;
    after.raw.assessed_value_usd = "$150,000,000";
    const events = diffProperty(before, after);
    expect(events).toEqual([
      {
        kind: "assessment_change",
        summary: "Assessed value now $150,000,000 (was $148,232,900).",
        rows: [{ assessed_value_usd: 150000000, raw: "$150,000,000" }],
        before: { assessed_value_usd: 148232900, raw: "$148,232,900" },
        after: { assessed_value_usd: 150000000, raw: "$150,000,000" },
      },
    ]);
  });

  it("yields sale when the sale date or price changes", () => {
    const after = parseProperty(fx("property-1234-market.md").replace("09/17/1993", "10/30/2026").replace("| $10 |", "| $210,000,000 |"));
    expect(diffProperty(before, after)).toEqual([
      {
        kind: "sale",
        summary: "Sale dated 30 Oct 2026 for $210,000,000.",
        rows: [{ sale_date: "2026-10-30", sale_price_usd: 210000000, raw: { sale_date: "10/30/2026", sale_price_usd: "$210,000,000" } }],
        before: { sale_date: "1993-09-17", sale_price_usd: 10, raw: { sale_date: "09/17/1993", sale_price_usd: "$10" } },
        after: { sale_date: "2026-10-30", sale_price_usd: 210000000, raw: { sale_date: "10/30/2026", sale_price_usd: "$210,000,000" } },
      },
    ]);
    const priceOnly = clone(before);
    priceOnly.sale_price_usd = 11;
    priceOnly.raw.sale_price_usd = "$11";
    expect(diffProperty(before, priceOnly).map((e) => [e.kind, e.summary])).toEqual([["sale", "Sale dated 17 Sep 1993 for $11."]]);
    const noDate = clone(priceOnly);
    noDate.sale_date = null;
    // the date cannot be compared, the price changed and can be: the sentence says what the new read has
    expect(diffProperty(before, noDate).map((e) => e.summary)).toEqual(["Sale for $11."]);
  });

  it("compares a sale field only when both reads have it: no event when one read could not parse a field", () => {
    const noDate = clone(before);
    noDate.sale_date = null;
    noDate.raw.sale_date = "Loading…";
    expect(diffProperty(before, noDate)).toEqual([]);
    expect(diffProperty(noDate, before)).toEqual([]); // and back again: still nothing
    const noPrice = clone(before);
    noPrice.sale_price_usd = null;
    noPrice.raw.sale_price_usd = "Loading…";
    expect(diffProperty(before, noPrice)).toEqual([]);
    expect(diffProperty(noPrice, before)).toEqual([]);
  });

  it("yields no sale when the earlier read had no sale (nothing to compare)", () => {
    const none = clone(before);
    none.sale_date = null;
    none.sale_price_usd = null;
    expect(diffProperty(none, before)).toEqual([]);
    const dateOnly = clone(none);
    dateOnly.sale_date = "1993-09-17";
    expect(diffProperty(dateOnly, before)).toEqual([]); // the price had no baseline
  });

  it("yields an 'other' event when the owners change, comparing only when both reads have owners", () => {
    const after = clone(before);
    after.owners = ["NEW OWNER LLC"];
    after.raw.owners = "NEW OWNER LLC";
    expect(diffProperty(before, after)).toEqual([
      {
        kind: "other",
        summary: "Owner changed from SEPTA to NEW OWNER LLC.",
        rows: [{ owners: ["NEW OWNER LLC"], raw: "NEW OWNER LLC" }],
        before: { owners: ["SEPTA"], raw: "SEPTA" },
        after: { owners: ["NEW OWNER LLC"], raw: "NEW OWNER LLC" },
      },
    ]);
    // the same owners in another order or case are not a change
    const two = clone(before);
    two.owners = ["SMITH JOHN", "SMITH MARY"];
    const reordered = clone(two);
    reordered.owners = ["Smith Mary", "SMITH JOHN"];
    expect(diffProperty(two, reordered)).toEqual([]);
    // a read with no owners, or a baseline with none, is not a change
    const ownerless = clone(before);
    ownerless.owners = [];
    expect(diffProperty(before, ownerless)).toEqual([]);
    expect(diffProperty(ownerless, before)).toEqual([]);
    // several owners are named with "and"
    expect(diffProperty(two, after)[0]!.summary).toBe("Owner changed from SMITH JOHN and SMITH MARY to NEW OWNER LLC.");
  });

  it("yields both when both change, and nothing when the new read could not parse a value", () => {
    const both = clone(before);
    both.assessed_value_usd = 1;
    both.sale_date = "2026-10-30";
    expect(diffProperty(before, both).map((e) => e.kind)).toEqual(["assessment_change", "sale"]);
    const unread = clone(before);
    unread.assessed_value_usd = null;
    unread.sale_date = null;
    unread.sale_price_usd = null;
    expect(diffProperty(before, unread)).toEqual([]);
  });
});

describe("li.parse", () => {
  const data = parseLi(fx("li-1234-market.md"));

  it("reads the selected building and the building count", () => {
    expect(data.buildings_count).toBe(3);
    expect(data.buildings).toEqual([
      {
        building_id: "1530931",
        name: "1234 Market Street Building",
        parcel_address: "1234 MARKET ST",
        height_ft: 283,
        footprint_sqft: 37016,
        raw: { height_ft: "283 ft", footprint_sqft: "37,016 sq ft" },
      },
    ]);
  });

  it("reads certifications", () => {
    expect(data.certifications.count).toBe(12);
    expect(data.certifications.recent).toHaveLength(5);
    expect(data.certifications.recent[0]).toEqual({
      type: "Fire Alarm Certification",
      date_inspected: "2025-10-13",
      result: "Certified",
      expiration_date: "2026-10-13",
      raw: { date_inspected: "10/13/2025", expiration_date: "10/13/2026" },
    });
  });

  it("reads permits: count 155, five recent rows, the L&I link from the H1", () => {
    expect(data.permits.count).toBe(155);
    expect(data.permits.recent).toHaveLength(5);
    expect(data.permits.recent[0]).toEqual({
      date: "2026-09-15",
      id: "EP-2026-004102",
      description: "Electrical Permit",
      status: "Issued",
      raw: { date: "09/15/2026" },
    });
    expect(data.permits.all_url).toBe("https://li.phila.gov/property-history/search?address=1234%20MARKET%20ST");
    expect(data.permits.depth).toBe("recent");
  });

  it("reads inspections, keeping both rows of an inspection id listed twice", () => {
    expect(data.inspections.count).toBe(99);
    expect(data.inspections.recent).toHaveLength(5);
    const clip = data.inspections.recent.filter((r) => r.id === "CF-2024-105044");
    expect(clip.map((r) => r.status)).toEqual(["PASSED", "FAILED"]);
  });

  it("reads violations and counts the open rows", () => {
    expect(data.violations.count).toBe(83);
    expect(data.violations.recent).toHaveLength(4);
    expect(data.violations.open_count).toBe(4);
    expect(data.violations.open_count_of).toBe(4);
    expect(parseLi(fx("li-1234-market-changed.md")).violations.open_count).toBe(3);
    expect(parseLi(fx("li-1234-market-changed.md")).violations.open_count_of).toBe(4);
  });

  it("reads appeals, a 'To Be Determined' date as null with the raw string", () => {
    expect(data.appeals.count).toBe(3);
    expect(data.appeals.recent[0]).toMatchObject({ date: "2023-02-02", id: "HA-2022-002343", type: "LIRB-H Tobacco", status: "Closed" });
    expect(data.appeals.recent[1]).toEqual({
      date: null,
      id: "HA-2022-001267",
      grounds: "See Attached",
      type: "LIRB Violation Appeal",
      status: "Closed",
      raw: { date: "To Be Determined" },
    });
    expect(data.appeals.recent[2]!.grounds).toMatch(/^I received a violation notice/);
  });

  it("reads zoning permit documents and business licences from the same page", () => {
    expect(data.zoning_documents.count).toBe(7);
    expect(data.zoning_documents.recent[0]).toEqual({
      date: "2022-09-12",
      permit_number: "ZP-2022-009939",
      pages: null,
      id: "ZP-2022-009939",
      raw: { date: "09/12/2022", pages: "N/A" },
    });
    expect(data.zoning_documents.recent[1]!.pages).toBe(8);
    expect(data.business_licenses.count).toBe(13);
    expect(data.business_licenses.recent[0]).toEqual({
      date: "2021-12-22",
      license_number: "883958",
      name: "M&H 1 LLC (Gateway News)",
      type: "Food Establishment, Retail Permanent Location",
      status: "Active",
      raw: { date: "12/22/2021" },
    });
  });

  it("parses a reordered page into the same rows", () => {
    const reordered = parseLi(fx("li-1234-market-reordered.md"));
    expect(reordered.permits.recent).toHaveLength(5);
    expect([...reordered.permits.recent].reverse()).toEqual(data.permits.recent);
    expect(reordered.buildings).toEqual(data.buildings);
  });

  it("counts one building when the sentence is absent, and null when nothing is shown", () => {
    const oneBuilding = fx("li-1234-market.md").replace("There are 3 buildings at this address\n", "");
    expect(parseLi(oneBuilding).buildings_count).toBe(1);
    expect(parseLi(fx("li-1234-market.md").replace("There are 3 buildings", "There is 1 building")).buildings_count).toBe(1);
    const noBuilding = parseLi("# 1 TEST ST\n\n## Permits (0)\n\n## Violations (0)\n");
    expect(noBuilding.buildings).toEqual([]);
    expect(noBuilding.buildings_count).toBeNull();
  });

  it("is not a read of the tab when the page is a Loading page (placeholders are not records)", () => {
    expect(readLi(fx("li-loading.md"))).toBeNull();
  });

  it("reads a one-cell Loading row as no record", () => {
    const page = fx("li-1234-market.md").replace(/\| 09\/15\/2026 \| EP-2026-004102 \|.*\n/, "| Loading permits... |\n");
    const permits = parseLi(page).permits.recent;
    expect(permits.map((r) => r.id)).toEqual(["EP-2026-008229", "EP-2026-001215", "MP-2025-005640", "CP-2025-006422"]);
  });

  it("keeps a page whose lists are empty (counts of 0, no Inspections header) as a read", () => {
    const empty = parseLi("# 2301 FITZWATER ST\n\nPHILADELPHIA, PA 19146\n\n## Permits (0)\n\n## Violations (0)\n");
    expect(empty.permits).toEqual({ count: 0, recent: [], all_url: "https://li.phila.gov/property-history/search?address=2301%20FITZWATER%20ST", depth: "recent" });
    expect(empty.violations).toEqual({ count: 0, recent: [], open_count: 0, open_count_of: 0 });
    expect(empty.inspections).toEqual({ count: null, recent: [] });
    const withMessage = parseLi(
      "# 2301 FITZWATER ST\n\n## Permits (0)\n\n| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| No permits found | | | |\n\n## Violations (0)\n",
    );
    expect(withMessage.permits.recent).toEqual([]);
  });

  it("reads a filled row that holds the word LOADING as a record", () => {
    const page = fx("li-1234-market.md").replace(
      "| 09/15/2026 | EP-2026-004102 | Electrical Permit | Issued |",
      "| 05/01/2026 | CP-2026-000001 | LOADING DOCK ALTERATION | Issued |",
    );
    expect(parseLi(page).permits.recent[0]).toMatchObject({ id: "CP-2026-000001", description: "LOADING DOCK ALTERATION" });
  });
});

describe("li.diff", () => {
  const original = parseLi(fx("li-1234-market.md"));

  it("finds exactly one new permit and one closed violation in the changed read", () => {
    const events = diffLi(original, parseLi(fx("li-1234-market-changed.md")));
    expect(events).toEqual([
      {
        kind: "new_permit",
        summary: "New permit EP-2026-009999 issued 30 Oct 2026 (Electrical Permit, Issued).",
        rows: [{ date: "2026-10-30", id: "EP-2026-009999", description: "Electrical Permit", status: "Issued", raw: { date: "10/30/2026" } }],
        before: null,
        after: { date: "2026-10-30", id: "EP-2026-009999", description: "Electrical Permit", status: "Issued", raw: { date: "10/30/2026" } },
      },
      {
        kind: "violation_closed",
        summary: "Violation CF-2026-141191 (WET CHEMICAL SYSTEM TEST) closed.",
        rows: [{ date: "2026-10-19", id: "CF-2026-141191", description: "WET CHEMICAL SYSTEM TEST", status: "CLOSED", raw: { date: "10/19/2026" } }],
        before: { date: "2026-10-19", id: "CF-2026-141191", description: "WET CHEMICAL SYSTEM TEST", status: "OPEN", raw: { date: "10/19/2026" } },
        after: { date: "2026-10-19", id: "CF-2026-141191", description: "WET CHEMICAL SYSTEM TEST", status: "CLOSED", raw: { date: "10/19/2026" } },
      },
    ]);
  });

  it("finds nothing in a reordered read, either way round, or in the same read", () => {
    const reordered = parseLi(fx("li-1234-market-reordered.md"));
    expect(diffLi(original, reordered)).toEqual([]);
    expect(diffLi(reordered, original)).toEqual([]);
    expect(diffLi(original, parseLi(fx("li-1234-market.md")))).toEqual([]);
  });

  it("finds nothing going back from the changed read: a removed row, a reopened violation, a row the window had hidden", () => {
    // CP-2025-006422 (4 Feb 2026) reappears but is older than the changed read's oldest permit (5 Feb 2026)
    expect(diffLi(parseLi(fx("li-1234-market-changed.md")), original)).toEqual([]);
  });

  it("ignores a 'new' row older than the oldest row the window showed, and reports a newer one", () => {
    const after = clone(original);
    after.permits.recent.push(
      { date: "2025-01-01", id: "EP-2024-000001", description: "Electrical Permit", status: "Completed", raw: { date: "01/01/2025" } },
      { date: "2026-03-01", id: "EP-2026-000300", description: "Electrical Permit", status: "Issued", raw: { date: "03/01/2026" } },
    );
    expect(diffLi(original, after).map((e) => [e.kind, (e.after as { id: string }).id])).toEqual([["new_permit", "EP-2026-000300"]]);
  });

  it("on a truncated list, a new row dated like the oldest shown row is new only when that list's count went up", () => {
    // Inspections: 99 counted, 5 shown, the oldest shown date is 24 Sep 2024 (the CF-2024-105044 pair)
    const swapped = clone(original);
    swapped.inspections.recent[4] = { date: "2024-09-24", id: "CF-2024-105999", description: "CLIP", status: "FAILED", raw: { date: "09/24/2024" } };
    expect(diffLi(original, swapped)).toEqual([]); // same count: a same-day neighbour the window now shows
    swapped.inspections.count = 100;
    expect(diffLi(original, swapped).map((e) => [e.kind, (e.after as { id: string }).id])).toEqual([["new_inspection", "CF-2024-105999"]]);
    // a strictly older row stays hidden even when the count went up; a newer one is new
    const older = clone(swapped);
    older.inspections.recent[4] = { date: "2024-09-23", id: "CF-2024-105998", description: "CLIP", status: "FAILED", raw: { date: "09/23/2024" } };
    expect(diffLi(original, older)).toEqual([]);
    const newer = clone(swapped);
    newer.inspections.recent[4] = { date: "2024-09-25", id: "CF-2024-105997", description: "CLIP", status: "FAILED", raw: { date: "09/25/2024" } };
    newer.inspections.count = 99;
    expect(diffLi(original, newer).map((e) => (e.after as { id: string }).id)).toEqual(["CF-2024-105997"]);
  });

  it("a rowset that only reorders same-day rows is not an event", () => {
    const reordered = clone(original);
    reordered.inspections.recent.reverse();
    expect(diffLi(original, reordered)).toEqual([]);
  });

  it("on a truncated list, a new row with no date is reported (it is not provably hidden)", () => {
    const after = clone(original);
    after.permits.recent.push({ date: null, id: "EP-2026-000778", description: "Electrical Permit", status: "Issued", raw: { date: "To Be Determined" } });
    after.violations.recent.push({ date: null, id: "CF-2026-999999", description: "SIGN", status: "OPEN", raw: { date: "" } });
    expect(diffLi(original, after).map((e) => e.summary)).toEqual([
      "New permit EP-2026-000778 (Electrical Permit, Issued); date To Be Determined.",
      "New violation CF-2026-999999 (SIGN, OPEN).",
    ]);
  });

  it("reports an older new row when the earlier read showed every row (nothing was hidden)", () => {
    // 3 appeals counted, 3 shown: the window hid nothing, so a backdated appeal is new
    const after = clone(original);
    after.appeals.recent.push({ date: "2020-01-01", id: "HA-2020-000001", grounds: "See Attached", type: "LIRB Violation Appeal", status: "In Process", raw: { date: "01/01/2020" } });
    after.appeals.count = 4;
    const events = diffLi(original, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "new_appeal",
      summary: "New appeal HA-2020-000001 dated 1 Jan 2020 (LIRB Violation Appeal, In Process).",
      before: null,
    });
  });

  it("still suppresses the older row when the earlier read of that list was truncated, or gave no count", () => {
    const older = { date: "2020-01-01", id: "HA-2020-000001", grounds: "See Attached", type: "LIRB Violation Appeal", status: "In Process", raw: { date: "01/01/2020" } };
    const truncated = clone(original);
    truncated.appeals.count = 4; // the earlier read counted 4 appeals and showed 3
    const after = clone(truncated);
    after.appeals.recent.push(older);
    expect(diffLi(truncated, after)).toEqual([]);
    const uncounted = clone(original);
    uncounted.appeals.count = null;
    const afterUncounted = clone(uncounted);
    afterUncounted.appeals.recent.push(older);
    expect(diffLi(uncounted, afterUncounted)).toEqual([]);
  });

  it("words a new appeal by its date, without saying what the date is", () => {
    const after = clone(original);
    after.appeals.recent.unshift({ date: "2026-10-30", id: "HA-2026-000003", grounds: "See Attached", type: "LIRB Violation Appeal", status: "In Process", raw: { date: "10/30/2026" } });
    after.appeals.count = 4;
    const events = diffLi(original, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "new_appeal",
      summary: "New appeal HA-2026-000003 dated 30 Oct 2026 (LIRB Violation Appeal, In Process).",
      before: null,
    });
    after.appeals.recent.unshift({ date: null, id: "HA-2026-000004", grounds: "See Attached", type: "LIRB Violation Appeal", status: "In Process", raw: { date: "To Be Determined" } });
    expect(diffLi(original, after).map((e) => e.summary)).toEqual([
      "New appeal HA-2026-000004 (LIRB Violation Appeal, In Process); date To Be Determined.",
      "New appeal HA-2026-000003 dated 30 Oct 2026 (LIRB Violation Appeal, In Process).",
    ]);
  });

  it("keys inspections on date, id, description and status, and violations on id and description", () => {
    const after = clone(original);
    after.inspections.recent.unshift({ date: "2026-10-19", id: "CF-2026-141276", description: "QOL FIRE SAFETY INVESTIGATOR", status: "PASSED", raw: { date: "10/19/2026" } });
    after.violations.recent.unshift({ date: "2026-10-19", id: "CF-2026-141191", description: "SPRINKLER SYSTEM", status: "OPEN", raw: { date: "10/19/2026" } });
    // every violation shown is dated 19 Oct 2026, so a new one on that day is new when the count went up
    after.violations.count = 84;
    const events = diffLi(original, after);
    expect(events.map((e) => e.kind)).toEqual(["new_inspection", "new_violation"]);
    expect(events[0]!.summary).toBe("New inspection CF-2026-141276 on 19 Oct 2026 (QOL FIRE SAFETY INVESTIGATOR, PASSED).");
    expect(events[1]!.summary).toBe("New violation CF-2026-141191 on 19 Oct 2026 (SPRINKLER SYSTEM, OPEN).");
  });

  it("reports a violation that moves to COMPLIED, and not one that only changes otherwise", () => {
    const after = clone(original);
    after.violations.recent[0]!.status = "COMPLIED";
    after.violations.recent[1]!.status = "IN VIOLATION";
    const events = diffLi(original, after);
    expect(events.map((e) => [e.kind, e.summary])).toEqual([["violation_closed", "Violation CF-2026-141276 (PERIODIC TESTING) complied."]]);
  });

  it("never reads an event from a Loading page", () => {
    // a Loading page is not a read (null), and diff is only called with reads
    expect(readLi(fx("li-loading.md"))).toBeNull();
  });

  describe("certification_expired", () => {
    it("needs opts: without them, no expiry events", () => {
      expect(diffLi(original, original)).toEqual([]);
      expect(diffLi(original, original, { now: "2026-10-20T00:00:00Z" })).toEqual([]);
    });

    it("reports the newest certification of a type whose expiry falls between the two reads", () => {
      const events = diffLi(original, original, { previousReadAt: "2026-10-01T00:00:00Z", now: "2026-10-20T00:00:00Z" });
      expect(events).toEqual([
        {
          kind: "certification_expired",
          summary: "Fire Alarm Certification expired 13 Oct 2026 (inspected 13 Oct 2025, Certified).",
          rows: [original.certifications.recent[0]],
          before: original.certifications.recent[0],
          after: original.certifications.recent[0],
        },
      ]);
    });

    it("does not report an expiry outside the window, or an older certification of the same type", () => {
      expect(diffLi(original, original, { previousReadAt: "2026-10-14T00:00:00Z", now: "2026-11-03T00:00:00Z" })).toEqual([]);
      // the window covers 13 Nov 2025 (an older Fire Alarm row) and 26 Feb 2025 is outside; only the newest per type counts
      const events = diffLi(original, original, { previousReadAt: "2025-11-01T00:00:00Z", now: "2026-10-20T00:00:00Z" });
      expect(events.map((e) => (e.after as { type: string; expiration_date: string }).expiration_date)).toEqual(["2026-10-13", "2026-01-29"]);
    });
  });
});

describe("zoning.parse", () => {
  const data = parseZoning(fx("zoning-1234-market.md"));

  it("reads the base district and the parcel count", () => {
    expect(data.base_district).toBe("CMX-5");
    expect(data.base_district_name).toBe("Center City Core Commercial Mixed-Use");
    expect(data.active_parcels).toBe(1);
  });

  it("reads overlays, bills, legislation and appeals, with the header counts", () => {
    expect(data.counts).toEqual({ pending_bills: 1, overlays: 12, legislation: 0, appeals: 1, rcos: 3 });
    expect(data.overlays).toHaveLength(5);
    expect(data.overlays[0]).toEqual({ name: "/CTR Center City Overlay District", code_section: "14-502(2)" });
    expect(data.pending_bills).toEqual([{ bill_type: "Overlay", current_zoning: "/CTR Center City Overlay District", bill: "260690" }]);
    expect(data.legislation).toEqual([]);
    expect(data.appeals).toEqual([
      {
        processed_date: "2007-03-26",
        id: "1589",
        description:
          "PERMIT FOR THE ERECTION OF A NON-ACCESSORY OUTDOOR ADVERTISING SIGN ABOVE THE BOTTOM OF THE 2ND. FLOOR OF AN EXISTING BUILDING.",
        scheduled_date: "2007-06-13",
        status: "WITHDRAWN",
        raw: { processed_date: "03/26/2007", scheduled_date: "06/13/2007" },
      },
    ]);
  });

  it("reads the registered community organizations", () => {
    expect(data.rcos).toHaveLength(3);
    expect(data.rcos[0]).toEqual({
      name: "Center City Organized for Responsible Development",
      address: "Arch Street United Methodist Church 55 N. Broad St. Philadelphia, PA 19107",
      meeting_address: "https://us02web.zoom.us/j/923149667",
      website: "https://centercityord.org/",
    });
    expect(data.rcos[1]!.meeting_address).toBeNull();
    expect(data.rcos[2]!.meeting_address).toBe("Zoom only");
  });

  it("keeps no contact person of a community organization: no name, phone or email", () => {
    expect(fx("zoning-1234-market.md")).toContain("contact.one@example.org");
    const stored = JSON.stringify(data);
    expect(stored).not.toContain("Sample Contact");
    expect(stored).not.toContain("555-01");
    expect(stored).not.toContain("example.org");
    for (const rco of data.rcos) expect(Object.keys(rco).sort()).toEqual(["address", "meeting_address", "name", "website"]);
  });

  it("leaves the floodplain flag null when overlays are hidden and none shown matches", () => {
    expect(data.floodplain_overlay).toBeNull();
  });

  it("sets the floodplain flag true on a shown floodplain overlay, false only when every overlay is shown", () => {
    const flood = fx("zoning-1234-market.md").replace(
      "| /CTR Center City Overlay District | 14-502(2) |  |",
      "| /FP Floodplain Overlay District | 14-704(1) |  |",
    );
    expect(parseZoning(flood).floodplain_overlay).toBe(true);
    const allShown = fx("zoning-1234-market.md").replace("## Overlays (12)", "## Overlays (5)");
    expect(parseZoning(allShown).floodplain_overlay).toBe(false);
  });

  it("reads a legislation row", () => {
    const page = fx("zoning-1234-market.md")
      .replace("## Record of Zoning Legislation (0)", "## Record of Zoning Legislation (1)")
      .replace("| No previous zoning legislation published | | | | |", "| 120001 | Enacted | 05/03/2012 | C-4 | CMX-5 |");
    expect(parseZoning(page).legislation).toEqual([
      { bill: "120001", status: "Enacted", enacted_date: "2012-05-03", original_zoning: "C-4", proposed_zoning: "CMX-5", raw: { enacted_date: "05/03/2012" } },
    ]);
  });
});

describe("deeds.parse", () => {
  const data = parseDeeds(fx("deeds-1234-market.md"));

  it("reads the parcel details", () => {
    expect(data).toMatchObject({
      map_registry: "001S070144",
      parcel_address: "1234 MARKET ST",
      parcel_status: "Active",
      origination_date: "2003-03-17",
      inactive_date: null,
      has_air_rights: false,
      is_condo: false,
      perimeter_ft: 886,
      area_sqft: 48148,
      active_parcels: 1,
    });
    expect(data.raw).toEqual({
      origination_date: "03/17/2003",
      inactive_date: "12/30/1899",
      has_air_rights: "No",
      is_condo: "No",
      perimeter_ft: "886 ft",
      area_sqft: "48,148 sq ft",
    });
  });

  it("reads the recorded documents", () => {
    expect(data.documents.count).toBe(36);
    expect(data.documents.recent).toHaveLength(5);
    expect(data.documents.recent[0]).toEqual({
      id: "54466485",
      date: "2025-09-11",
      type: "CONTINUATION",
      grantor: "SOUTHEASTERN PENNSYLVANIA TRANSPORTATION AUTHORITY",
      grantee: "BANC OF AMERICA PUBLIC CAPITAL CORP",
      unit: null,
      raw: { date: "09/11/2025" },
    });
    expect(data.documents.all_url).toBeNull();
  });

  it("reads a real inactive date and Yes flags", () => {
    const page = fx("deeds-1234-market.md")
      .replace("| Inactive Date | 12/30/1899 |", "| Inactive Date | 01/02/2020 |")
      .replace("| Has Air Rights | No |", "| Has Air Rights | Yes |")
      .replace("| Is Condo | No |", "| Is Condo | Yes |");
    const d = parseDeeds(page);
    expect([d.inactive_date, d.has_air_rights, d.is_condo]).toEqual(["2020-01-02", true, true]);
  });
});

describe("section registry", () => {
  it("holds the nine sections in sheet order", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      "property",
      "zoning",
      "licenses_inspections",
      "deeds",
      "assessment_history",
      "tax",
      "flood",
      "schools",
      "li_deep",
    ]);
    expect(FREE_SECTION_IDS).toEqual(["property", "zoning", "licenses_inspections", "deeds"]);
    expect(STANDARD_AGENT_SECTION_IDS).toEqual(["assessment_history", "tax", "schools", "flood"]);
    expect(DEEP_SECTION_ID).toBe("li_deep");
  });

  it("finds every section by id, and nothing for an unknown id", () => {
    for (const s of SECTIONS) expect(getSection(s.id)).toBe(s);
    expect(getSection("nearby")).toBeUndefined();
    expect(getSection("licenses_inspections")).toBe(liAdapter);
  });

  it("names agency, label, method and monitorability for each", () => {
    expect(SECTIONS.map((s) => [s.id, s.agency, s.label, s.method, s.monitorable])).toEqual([
      ["property", "Office of Property Assessment", "Assessment and sale", "fetch", true],
      ["zoning", "Department of Planning and Development", "Zoning", "fetch", false],
      ["licenses_inspections", "Department of Licenses & Inspections", "Licences and inspections", "fetch", true],
      ["deeds", "Department of Records", "Deeds and parcel", "fetch", false],
      ["assessment_history", "Office of Property Assessment", "Assessment history", "agent", false],
      ["tax", "Department of Revenue", "Real estate tax", "agent", false],
      ["flood", "FEMA", "Flood zone", "agent", false],
      ["schools", "School District of Philadelphia", "Catchment schools", "agent", false],
      ["li_deep", "Department of Licenses & Inspections", "Permit and violation history", "agent", false],
    ]);
  });

  it("gives the two watched sections the Monitor purposes from the spec", () => {
    expect(liAdapter.purpose).toBe(
      "A permit, inspection, violation, appeal or building certification was added or changed status. Ignore timestamps, ordering and layout.",
    );
    expect(propertyAdapter.purpose).toBe("The assessed value, owner, sale date or sale price changed.");
    expect(SECTIONS.filter((s) => s.purpose !== undefined).map((s) => s.id)).toEqual(["property", "licenses_inspections"]);
  });

  it("builds each section's URL for 1234 MARKET ST", () => {
    expect(Object.fromEntries(SECTIONS.map((s) => [s.id, s.url(CTX)]))).toEqual({
      property: "https://atlas.phila.gov/1234%20MARKET%20ST/property",
      zoning: "https://atlas.phila.gov/1234%20MARKET%20ST/zoning",
      licenses_inspections: "https://atlas.phila.gov/1234%20MARKET%20ST/li",
      deeds: "https://atlas.phila.gov/1234%20MARKET%20ST/deeds",
      assessment_history: "https://property.phila.gov/?p=883309050",
      tax: "https://tax-services.phila.gov/_/",
      flood: "https://msc.fema.gov/portal/search",
      schools: "https://webapps1.philasd.org/school_finder/",
      li_deep: "https://li.phila.gov/property-history/search?address=1234%20MARKET%20ST",
    });
  });

  it("gives flood a manual link and every other section its own URL as the manual link", () => {
    expect(getSection("flood")!.manualUrl!(CTX)).toBe("https://msc.fema.gov/portal/search?AddressQuery=1234%20MARKET%20ST%2C%20Philadelphia%2C%20PA");
    expect(manualUrlFor(getSection("flood")!, CTX)).toBe("https://msc.fema.gov/portal/search?AddressQuery=1234%20MARKET%20ST%2C%20Philadelphia%2C%20PA");
    expect(manualUrlFor(getSection("deeds")!, CTX)).toBe("https://atlas.phila.gov/1234%20MARKET%20ST/deeds");
  });

  it("wires parsers and diffs: the fetch sections parse, only the watched ones diff, the Agent ones are metadata", () => {
    expect(SECTIONS.filter((s) => s.parse !== undefined).map((s) => s.id)).toEqual(["property", "zoning", "licenses_inspections", "deeds"]);
    expect(SECTIONS.filter((s) => s.diff !== undefined).map((s) => s.id)).toEqual(["property", "licenses_inspections"]);
    expect(zoningAdapter.parse!(fx("zoning-1234-market.md"))).toEqual(parseZoning(fx("zoning-1234-market.md")));
    expect(deedsAdapter.parse!(fx("deeds-1234-market.md"))).toEqual(parseDeeds(fx("deeds-1234-market.md")));
    const li: SectionAdapter<LicensesInspectionsData> = getSection("licenses_inspections");
    const before = must(li.parse!(fx("li-1234-market.md")));
    const after = must(li.parse!(fx("li-1234-market-changed.md")));
    expect(li.diff!(before, after).map((e) => e.kind)).toEqual(["new_permit", "violation_closed"]);
    const depth: Depth = before.permits.depth;
    expect(depth).toBe("recent");
    for (const id of ["assessment_history", "tax", "flood", "schools", "li_deep"]) {
      const s = getSection(id)!;
      expect([s.parse, s.diff]).toEqual([undefined, undefined]);
      expect([s.goal, s.parseResult, s.classifyResult]).toEqual([
        expect.any(Function), expect.any(Function), expect.any(Function),
      ]);
      expect(s.outputSchema).toEqual(expect.any(Object));
    }
  });
});
