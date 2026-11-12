import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressVariants, compareResolved, normalizeAddress } from "../src/address/normalize";
import { AtlasUnavailableError, parseCondoUnits, resolveAddress } from "../src/address/resolve";
import { FETCH_RETRY_DELAY_MS, FETCH_RETRY_ON_LOADING } from "../src/core/limits";
import { fetchAtlas, isIncomplete } from "../src/tinyfish/fetch";
import { fetchMock } from "./helpers/fetch-mock";

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fx(name: string): string {
  const text = fixtures[`./fixtures/atlas/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}

const FETCH_API = "https://api.fetch.tinyfish.ai";
const atlasUrl = (address: string, tab = "property") => `https://atlas.phila.gov/${encodeURIComponent(address)}/${tab}`;

// What a mocked atlas URL answers: page text, the recorded empty_content miss, or an HTTP failure.
const EMPTY = Symbol("empty_content");
const HTTP_500 = Symbol("http_500");
const UNREACHABLE = Symbol("target_unreachable");
type Answer = string | typeof EMPTY | typeof HTTP_500 | typeof UNREACHABLE;

/** Every TinyFetch call is a POST to one URL, so answers are routed on the atlas URL in the body.
 *  A list is consumed in order and its last answer repeats. A URL with no route is recorded and
 *  fails the test in afterEach (fetchAtlas would otherwise hide the mock's error as fetch_failed). */
const unrouted: string[] = [];
function mockAtlas(routes: Record<string, Answer | Answer[]>): void {
  const queues = new Map(Object.entries(routes).map(([url, a]) => [url, Array.isArray(a) ? [...a] : [a]]));
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0]!;
      const queue = queues.get(url);
      if (!queue) {
        unrouted.push(url);
        throw new Error(`test has no answer for ${url}`);
      }
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (answer === HTTP_500) {
        return Response.json({ error: { code: "internal_error", message: "boom" } }, { status: 500 });
      }
      if (answer === UNREACHABLE) {
        return Response.json({ error: { code: "target_unreachable", message: "down" } }, { status: 400 });
      }
      if (answer === EMPTY) {
        const miss = JSON.parse(fx("property-empty.json")) as { errors: { url: string }[] };
        miss.errors[0]!.url = url;
        return Response.json(miss);
      }
      return Response.json({ results: [{ url, final_url: url, title: "Atlas", text: answer }], errors: [] });
    },
  });
}

/** The atlas URLs asked for, in order. */
function requested(): string[] {
  return fetchMock.calls.map((c) => (c.body as { urls: string[] }).urls[0]!);
}

const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

beforeEach(() => {
  fetchMock.activate();
  sleeps.length = 0;
  unrouted.length = 0;
});
afterEach(() => {
  fetchMock.reset();
  expect(unrouted).toEqual([]);
});

describe("normalizeAddress", () => {
  it("drops the trailing period, city, state and ZIP, and maps the suffix", () => {
    expect(normalizeAddress("1234 market st.").display).toBe("1234 MARKET ST");
    expect(normalizeAddress("1234 Market Street, Philadelphia, PA 19107").display).toBe("1234 MARKET ST");
    expect(normalizeAddress("2140 Spruce Street Apt 4B").unit).toBe("4B");
  });

  it.each([
    ["1234 Market St Philadelphia PA 19107", "1234 MARKET ST"],
    ["1234 Market St, Philadelphia, PA 19107-3721", "1234 MARKET ST"],
    ["1234 Market St 191073721", "1234 MARKET ST"],
    ["1234 Market St., Philadelphia, PA, 19107.", "1234 MARKET ST"],
    ["1234 Market St, Pennsylvania 19107", "1234 MARKET ST"],
    ["1234 Market St 19107 PA Philadelphia", "1234 MARKET ST"],
    ["  1234   Market \t St  ", "1234 MARKET ST"],
    ["1234 Market Street Philadelphia", "1234 MARKET ST"],
  ])("strips the tail of %j", (input, street) => {
    expect(normalizeAddress(input).street).toBe(street);
  });

  it.each([
    ["123 North Broad Street", "123 N BROAD ST"],
    ["500 S. 5th St.", "500 S 5TH ST"],
    ["2000 West Girard Avenue", "2000 W GIRARD AVE"],
    ["4001 Roosevelt Boulevard", "4001 ROOSEVELT BLVD"],
    ["10 Lemon Hill Drive", "10 LEMON HILL DR"],
    ["1 Parkside Parkway", "1 PARKSIDE PKWY"],
    ["70 Rittenhouse Square", "70 RITTENHOUSE SQ"],
    ["9 Cherry Terrace", "9 CHERRY TER"],
    ["5 Quince Place", "5 QUINCE PL"],
    ["8 Elm Court", "8 ELM CT"],
    ["3 Mill Lane", "3 MILL LN"],
    ["6 Mill Road", "6 MILL RD"],
  ])("maps the suffix and direction of %j", (input, street) => {
    expect(normalizeAddress(input).street).toBe(street);
  });

  it("leaves a street name that is also a suffix or direction word alone", () => {
    expect(normalizeAddress("1234 Lane St").street).toBe("1234 LANE ST");
    expect(normalizeAddress("1234 North Street").street).toBe("1234 NORTH ST");
    expect(normalizeAddress("12 Court").street).toBe("12 COURT");
  });

  it.each([
    ["2140 Spruce St #4B", "4B"],
    ["2140 Spruce St # 4B", "4B"],
    ["2140 Spruce St Unit 4B", "4B"],
    ["2140 Spruce St Unit #4B", "4B"],
    ["2140 Spruce St, Apt. 4b", "4B"],
    ["2140 Spruce Street Apartment 4B, Philadelphia, PA 19103", "4B"],
    ["1234 Market St Ste 200", "200"],
    ["1234 Market St Suite 12-A", "12-A"],
  ])("takes the unit out of %j", (input, unit) => {
    const n = normalizeAddress(input);
    expect(n.unit).toBe(unit);
    expect(n.street).toMatch(/^\d+ [A-Z ]+ ST$/);
    expect(n.street).not.toContain(unit);
  });

  it("returns a null unit and a display equal to the street when there is no unit", () => {
    expect(normalizeAddress("1234 Market St")).toEqual({ street: "1234 MARKET ST", unit: null, display: "1234 MARKET ST" });
    // display is the street only; the unit is carried separately
    expect(normalizeAddress("2140 Spruce St Apt 4B")).toEqual({ street: "2140 SPRUCE ST", unit: "4B", display: "2140 SPRUCE ST" });
  });

  it("does not take a street named like a unit keyword for a unit", () => {
    expect(normalizeAddress("100 Suite St").unit).toBeNull();
  });

  it.each([
    ["1234 W Stewart", "1234 W STEWART"],
    ["1234 N Stenton", "1234 N STENTON"],
    ["1234 N Stenton Ave", "1234 N STENTON AVE"],
    ["1234 W Stewart St, Philadelphia, PA 19132", "1234 W STEWART ST"],
    ["100 Unity St", "100 UNITY ST"],
    ["100 Aptos Ave", "100 APTOS AVE"],
  ])("does not read the start of a street name as a unit keyword: %j", (input, street) => {
    expect(normalizeAddress(input)).toEqual({ street, unit: null, display: street });
  });

  it("takes a # unit that follows the street with no space", () => {
    expect(normalizeAddress("2140 Spruce St#4B")).toEqual({ street: "2140 SPRUCE ST", unit: "4B", display: "2140 SPRUCE ST" });
  });

  it.each([
    ["123 Pennsylvania", "123 PENNSYLVANIA"],
    ["123 Pennsylvania Ave", "123 PENNSYLVANIA AVE"],
    ["123 Pennsylvania PA 19107", "123 PENNSYLVANIA"],
    ["123 Pennsylvania, Philadelphia, PA 19107", "123 PENNSYLVANIA"],
    ["1 S Penn Sq", "1 S PENN SQ"],
    ["100 N Broad St", "100 N BROAD ST"],
    ["1234 Market St PA", "1234 MARKET ST"],
  ])("keeps a state name that is the street name, strips one that is a tail: %j", (input, street) => {
    expect(normalizeAddress(input).street).toBe(street);
  });

  it("returns an empty street for blank input", () => {
    expect(normalizeAddress("   ")).toEqual({ street: "", unit: null, display: "" });
  });
});

describe("addressVariants", () => {
  it("lists the raw trimmed input, then the normalized street", () => {
    expect(addressVariants("  1234 market st.  ")).toEqual(["1234 market st.", "1234 MARKET ST"]);
    expect(addressVariants("1234 Market St Philadelphia PA 19107")).toEqual([
      "1234 Market St Philadelphia PA 19107",
      "1234 MARKET ST",
    ]);
  });

  it("drops the normalized form when it equals the raw input apart from case", () => {
    expect(addressVariants("1234 Market St")).toEqual(["1234 Market St"]);
    expect(addressVariants("1234 MARKET ST")).toEqual(["1234 MARKET ST"]);
  });

  it("has no variants for blank input", () => {
    expect(addressVariants("  ")).toEqual([]);
  });
});

describe("compareResolved", () => {
  it("is exact when only the suffix form and case differ", () => {
    expect(compareResolved("1234 Market Street", "1234 MARKET ST")).toBe("exact");
    expect(compareResolved("1234 market st.", "1234 MARKET ST")).toBe("exact");
    expect(compareResolved("1234 Market St Philadelphia PA 19107", "1234 MARKET ST")).toBe("exact");
    expect(compareResolved("123 North Broad Street", "123 N BROAD ST")).toBe("exact");
  });

  it("is exact when the input has no suffix (a suffix-only difference)", () => {
    expect(compareResolved("1234 Market", "1234 MARKET ST")).toBe("exact");
  });

  it("is fuzzy when the street name is misspelled", () => {
    expect(compareResolved("1234 Markt St", "1234 MARKET ST")).toBe("fuzzy");
    expect(compareResolved("1234 Chestnt St", "1234 CHESTNUT ST")).toBe("fuzzy");
  });

  it("is fuzzy when the house number differs, even with the same street", () => {
    expect(compareResolved("1236 Market St", "1234 MARKET ST")).toBe("fuzzy");
    expect(compareResolved("1234 Market St", "1500S MARKET ST")).toBe("fuzzy");
  });

  it("is fuzzy when both sides name a different suffix or a direction was left out", () => {
    expect(compareResolved("1234 Market Ave", "1234 MARKET ST")).toBe("fuzzy");
    expect(compareResolved("1234 Broad St", "1234 N BROAD ST")).toBe("fuzzy");
  });
});

describe("isIncomplete", () => {
  it("flags the recorded /li read with Loading placeholders, not the complete one", () => {
    expect(isIncomplete(fx("li-loading.md"))).toBe(true);
    expect(isIncomplete(fx("li-1234-market.md"))).toBe(false);
  });

  it("flags a Loading line on its own and a Loading table row with empty cells, in any case", () => {
    expect(isIncomplete("# 1234 MARKET ST\n\nLoading buildings\n")).toBe(true);
    expect(isIncomplete("# X\n\nLOADING BUILDINGS...\n")).toBe(true);
    expect(isIncomplete("# X\n\nLoading…\n")).toBe(true);
    expect(isIncomplete("| Date | ID |\n| --- | --- |\n| Loading permits... | |\n")).toBe(true);
    expect(isIncomplete("| Date | ID |\n| --- | --- |\n| loading L&I appeals… | | |\n")).toBe(true);
    expect(isIncomplete("| Date | ID |\n| --- | --- |\n| Loading zoning permit documents | | |\n")).toBe(true);
  });

  it("flags a Loading row that has only the one cell", () => {
    expect(isIncomplete("| Loading permits... |\n")).toBe(true);
    expect(isIncomplete("| Date |\n| --- |\n| Loading permits |\n")).toBe(true);
    expect(isIncomplete("| 05/01/2026 |\n")).toBe(false);
  });

  it("reads a count with a thousands comma", () => {
    const header = "## Permits (1,234)\n\n| Date | ID |\n| --- | --- |\n";
    expect(isIncomplete(header)).toBe(true);
    expect(isIncomplete(header + "| 05/01/2026 | CP-1 |\n")).toBe(false);
    expect(isIncomplete("## Permits (0,000)\n\nNone\n")).toBe(false);
  });

  it("flags a counted section that has a header row and separator but no data rows", () => {
    const text = "# X\n\n## Permits (155)\n\n| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n\nSee all permits\n\n## Violations (0)\n\nNone\n";
    expect(isIncomplete(text)).toBe(true);
    // the next ## header ends the section: rows below it do not count for the one above
    const second = "## Permits (2)\n\n| A | B |\n| --- | --- |\n\n## Inspections (1)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    expect(isIncomplete(second)).toBe(true);
  });

  it("does not flag a counted section with rows, a zero count, or a header without a count", () => {
    expect(isIncomplete("## Permits (1)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n")).toBe(false);
    expect(isIncomplete("## Permits (0)\n\nNo permits.\n")).toBe(false);
    expect(isIncomplete("## Parcel Details\n\nplain text\n")).toBe(false);
    expect(isIncomplete(fx("property-1500-market.md"))).toBe(false);
    expect(isIncomplete(fx("property-1234-market.md"))).toBe(false);
    expect(isIncomplete(fx("condos-1500-market.md"))).toBe(false);
  });

  it("does not flag the word LOADING inside real data", () => {
    const filled = "## Permits (1)\n\n| Date | ID | Description | Status |\n| --- | --- | --- | --- |\n| 05/01/2026 | CP-2026-000001 | LOADING DOCK ALTERATION | Issued |\n";
    expect(isIncomplete(filled)).toBe(false);
    expect(isIncomplete("Loading dock repairs were permitted in 2019.\n")).toBe(false);
    expect(isIncomplete("| Loading dock alteration | CP-1 | Issued | |\n")).toBe(false);
  });
});

describe("fetchAtlas", () => {
  it("reads the encoded atlas URL as markdown and returns the text", async () => {
    mockAtlas({ [atlasUrl("1234 Market Street", "li")]: fx("li-1234-market.md") });
    const res = await fetchAtlas(env, "1234 Market Street", "li", { sleep });
    expect(res).toEqual({ ok: true, text: fx("li-1234-market.md"), url: "https://atlas.phila.gov/1234%20Market%20Street/li" });
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0]!.body).toMatchObject({ urls: ["https://atlas.phila.gov/1234%20Market%20Street/li"], format: "markdown" });
    expect(sleeps).toEqual([]);
  });

  it("retries an incomplete read and returns the complete one", async () => {
    const url = atlasUrl("1234 Market Street", "li");
    mockAtlas({ [url]: [fx("li-loading.md"), fx("li-1234-market.md")] });
    const res = await fetchAtlas(env, "1234 Market Street", "li", { sleep });
    expect(res).toEqual({ ok: true, text: fx("li-1234-market.md"), url });
    expect(fetchMock.calls).toHaveLength(2);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS]);
  });

  it("returns incomplete_after_retries after exactly four reads and three waits", async () => {
    const url = atlasUrl("1234 Market St", "li");
    mockAtlas({ [url]: fx("li-loading.md") });
    const res = await fetchAtlas(env, "1234 Market St", "li", { sleep });
    expect(res).toEqual({ ok: false, error: "incomplete_after_retries", url });
    expect(FETCH_RETRY_ON_LOADING).toBe(3);
    expect(fetchMock.calls).toHaveLength(1 + FETCH_RETRY_ON_LOADING);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS]);
  });

  it("succeeds on the last retry", async () => {
    const url = atlasUrl("1234 Market St", "li");
    const loading = fx("li-loading.md");
    mockAtlas({ [url]: [loading, loading, loading, fx("li-1234-market.md")] });
    expect((await fetchAtlas(env, "1234 Market St", "li", { sleep })).ok).toBe(true);
    expect(fetchMock.calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it("retries empty_content and returns the complete page", async () => {
    const url = atlasUrl("1234 Market St", "li");
    mockAtlas({ [url]: [EMPTY, fx("li-1234-market.md")] });
    const res = await fetchAtlas(env, "1234 Market St", "li", { sleep });
    expect(res).toEqual({ ok: true, text: fx("li-1234-market.md"), url });
    expect(fetchMock.calls).toHaveLength(2);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS]);
  });

  it("returns empty_content after one read when the caller says an empty answer is final", async () => {
    const url = atlasUrl("1234 market st.");
    mockAtlas({ [url]: EMPTY });
    expect(await fetchAtlas(env, "1234 market st.", "property", { sleep, emptyIsFinal: true })).toEqual({ ok: false, error: "empty_content", url });
    expect(requested()).toEqual([url]);
    expect(sleeps).toEqual([]);
  });

  it("returns empty_content after four empty reads", async () => {
    const url = atlasUrl("1234 Market St", "li");
    mockAtlas({ [url]: EMPTY });
    expect(await fetchAtlas(env, "1234 Market St", "li", { sleep })).toEqual({ ok: false, error: "empty_content", url });
    expect(fetchMock.calls).toHaveLength(1 + FETCH_RETRY_ON_LOADING);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS]);
  });

  it("retries empty then loading then returns the complete page, sharing one retry count", async () => {
    const url = atlasUrl("1234 Market St", "li");
    mockAtlas({ [url]: [EMPTY, fx("li-loading.md"), fx("li-1234-market.md")] });
    const res = await fetchAtlas(env, "1234 Market St", "li", { sleep });
    expect(res).toEqual({ ok: true, text: fx("li-1234-market.md"), url });
    expect(fetchMock.calls).toHaveLength(3);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS]);
  });

  it("returns incomplete_after_retries when empty and loading together exhaust the shared retries", async () => {
    const url = atlasUrl("1234 Market St", "li");
    const loading = fx("li-loading.md");
    mockAtlas({ [url]: [EMPTY, loading, loading, loading] });
    expect(await fetchAtlas(env, "1234 Market St", "li", { sleep })).toEqual({
      ok: false,
      error: "incomplete_after_retries",
      url,
    });
    expect(fetchMock.calls).toHaveLength(1 + FETCH_RETRY_ON_LOADING);
    expect(sleeps).toHaveLength(FETCH_RETRY_ON_LOADING);
  });

  it("does not retry a definite error", async () => {
    const url = atlasUrl("1234 Market St", "property");
    mockAtlas({ [url]: UNREACHABLE });
    expect(await fetchAtlas(env, "1234 Market St", "property", { sleep })).toEqual({
      ok: false,
      error: "target_unreachable",
      url,
    });
    expect(fetchMock.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries an HTTP 500 and returns the last error", async () => {
    const url = atlasUrl("1234 Market St", "property");
    mockAtlas({ [url]: HTTP_500 });
    expect(await fetchAtlas(env, "1234 Market St", "property", { sleep })).toEqual({
      ok: false,
      error: "internal_error",
      url,
    });
    expect(fetchMock.calls).toHaveLength(1 + FETCH_RETRY_ON_LOADING);
    expect(sleeps).toHaveLength(FETCH_RETRY_ON_LOADING);
  });

  it("reports a network failure as fetch_failed instead of throwing, retries it, and logs the error name only", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.intercept({
      method: "POST",
      url: FETCH_API,
      times: Infinity,
      reply: () => {
        throw new TypeError("network down for 1234 Market St");
      },
    });
    expect(await fetchAtlas(env, "1234 Market St", "property", { sleep })).toEqual({
      ok: false,
      error: "fetch_failed",
      url: atlasUrl("1234 Market St"),
    });
    expect(fetchMock.calls).toHaveLength(1 + FETCH_RETRY_ON_LOADING);
    expect(logged).toHaveBeenCalledTimes(1 + FETCH_RETRY_ON_LOADING);
    for (const call of logged.mock.calls) {
      const text = call.map(String).join(" ");
      expect(text).toContain("TypeError");
      expect(text).not.toContain("network down");
      expect(text).not.toContain("1234");
    }
    logged.mockRestore();
  });

  it("works without an injected sleep when the first read is complete", async () => {
    mockAtlas({ [atlasUrl("1234 Market St")]: fx("property-1234-market.md") });
    expect((await fetchAtlas(env, "1234 Market St", "property")).ok).toBe(true);
  });
});

describe("resolveAddress", () => {
  const MARKET = fx("property-1234-market.md");

  // The uppercase form `1234%20MARKET%20ST` was read live on 3 Nov (12:30 UTC): the same 884-char page as `1234 Market St`.
  it("resolves exact: the raw form is rejected, the normalized form returns the page", async () => {
    mockAtlas({ [atlasUrl("1234 market st.")]: EMPTY, [atlasUrl("1234 MARKET ST")]: MARKET });
    const res = await resolveAddress(env, { address: "1234 market st." }, { sleep });
    expect(res).toEqual({
      outcome: "resolved",
      resolution: "exact",
      address_resolved: "1234 MARKET ST",
      opa_account: "883309050",
      units: null,
      property_text: MARKET,
      variants_tried: ["1234 market st.", "1234 MARKET ST"],
    });
    // An empty answer to the text as typed means "no such address": the cleaned form is tried at once.
    expect(requested()).toEqual([atlasUrl("1234 market st."), atlasUrl("1234 MARKET ST")]);
    expect(sleeps).toEqual([]);
  });

  it("resolves '1234 Market St Philadelphia PA 19107' to the same OPA account as '1234 Market St', without a wait", async () => {
    const withTail = "1234 Market St Philadelphia PA 19107";
    mockAtlas({ [atlasUrl(withTail)]: EMPTY, [atlasUrl("1234 MARKET ST")]: MARKET, [atlasUrl("1234 Market St")]: MARKET });
    const tail = await resolveAddress(env, { address: withTail }, { sleep });
    const plain = await resolveAddress(env, { address: "1234 Market St" });
    expect(tail).toMatchObject({ outcome: "resolved", opa_account: "883309050", resolution: "exact", address_resolved: "1234 MARKET ST" });
    expect(plain).toMatchObject({ outcome: "resolved", opa_account: "883309050", resolution: "exact" });
    expect(requested()).toEqual([atlasUrl(withTail), atlasUrl("1234 MARKET ST"), atlasUrl("1234 Market St")]);
    expect(sleeps).toEqual([]);
  });

  it("resolves 'Market Street' to the same page as 'Market St' without a second request", async () => {
    mockAtlas({ [atlasUrl("1234 Market Street")]: MARKET });
    const res = await resolveAddress(env, { address: "1234 Market Street" });
    expect(res).toMatchObject({ outcome: "resolved", resolution: "exact", variants_tried: ["1234 Market Street"] });
    expect(requested()).toHaveLength(1);
  });

  it("marks the typo as fuzzy when the atlas matches it to the real street", async () => {
    mockAtlas({ [atlasUrl("1234 Markt St")]: MARKET });
    const res = await resolveAddress(env, { address: "1234 Markt St" });
    expect(res).toMatchObject({ outcome: "resolved", resolution: "fuzzy", address_resolved: "1234 MARKET ST", opa_account: "883309050" });
  });

  it("marks a house-number mismatch as fuzzy", async () => {
    mockAtlas({ [atlasUrl("1236 Market St")]: MARKET });
    const res = await resolveAddress(env, { address: "1236 Market St" });
    expect(res).toMatchObject({ outcome: "resolved", resolution: "fuzzy", address_resolved: "1234 MARKET ST" });
  });

  const CONDOS_LIST = [
    { address: "1500-42 MARKET ST", opa_account: "883320000" },
    { address: "1500S MARKET ST", opa_account: "875100060" },
  ];

  it("treats a condominium parent as resolved, with the unit count and the unit list from the condos tab", async () => {
    mockAtlas({
      [atlasUrl("1500 Market St")]: fx("property-1500-market.md"),
      [atlasUrl("1500 Market St", "condos")]: fx("condos-1500-market.md"),
    });
    const res = await resolveAddress(env, { address: "1500 Market St" });
    expect(res).toMatchObject({
      outcome: "resolved",
      resolution: "parent",
      address_resolved: "1500 MARKET ST",
      opa_account: "883320000",
      units: { count: 2, list: CONDOS_LIST, list_url: "https://atlas.phila.gov/1500%20Market%20St/condos" },
      property_text: fx("property-1500-market.md"),
    });
    expect(requested()).toEqual([atlasUrl("1500 Market St"), atlasUrl("1500 Market St", "condos")]);
  });

  it.each([
    ["an HTTP failure", HTTP_500],
    ["empty_content", EMPTY],
    ["a page without the unit table", fx("property-no-record.md")],
    ["a page that stays incomplete", "# 1500 MARKET ST\n\nLoading condominiums\n"],
  ] as [string, Answer][])("keeps the parent resolution with list null when the condos read ends in %s", async (_label, answer) => {
    mockAtlas({ [atlasUrl("1500 Market St")]: fx("property-1500-market.md"), [atlasUrl("1500 Market St", "condos")]: answer });
    const res = await resolveAddress(env, { address: "1500 Market St" }, { sleep });
    expect(res).toMatchObject({
      outcome: "resolved",
      resolution: "parent",
      opa_account: "883320000",
      units: { count: 2, list: null, list_url: "https://atlas.phila.gov/1500%20Market%20St/condos" },
    });
  });

  it("reads the condos tab at the address that served /property, and at the H1 address when found by OPA account", async () => {
    mockAtlas({
      [atlasUrl("1500 market st.")]: EMPTY,
      [atlasUrl("1500 MARKET ST")]: fx("property-1500-market.md"),
      [atlasUrl("1500 MARKET ST", "condos")]: fx("condos-1500-market.md"),
      [atlasUrl("883320000")]: fx("property-1500-market.md"),
    });
    const byAddress = await resolveAddress(env, { address: "1500 market st." }, { sleep });
    expect(byAddress).toMatchObject({ resolution: "parent", units: { list: CONDOS_LIST, list_url: "https://atlas.phila.gov/1500%20MARKET%20ST/condos" } });
    fetchMock.calls.length = 0;
    const byAccount = await resolveAddress(env, { opa_account: "883320000" });
    expect(byAccount).toMatchObject({ resolution: "parent", units: { list: CONDOS_LIST, list_url: "https://atlas.phila.gov/1500%20MARKET%20ST/condos" } });
    expect(requested()).toEqual([atlasUrl("883320000"), atlasUrl("1500 MARKET ST", "condos")]);
  });

  it("prefers parent over fuzzy when the matched address is a condominium parent", async () => {
    mockAtlas({ [atlasUrl("1500 Markt St")]: fx("property-1500-market.md"), [atlasUrl("1500 Markt St", "condos")]: fx("condos-1500-market.md") });
    const res = await resolveAddress(env, { address: "1500 Markt St" });
    expect(res).toMatchObject({ outcome: "resolved", resolution: "parent", units: { count: 2 } });
  });

  it("detects a parent from 'There are N active parcels'", async () => {
    mockAtlas({
      [atlasUrl("1234 Market St")]: MARKET + "\n## There are 3 active parcels at this address.\n",
      [atlasUrl("1234 Market St", "condos")]: EMPTY,
    });
    expect(await resolveAddress(env, { address: "1234 Market St" }, { sleep })).toMatchObject({ resolution: "parent", units: { count: 3, list: null } });
  });

  it("ignores a count of 1 and does not read the condos tab", async () => {
    mockAtlas({ [atlasUrl("1234 Market St")]: MARKET + "\n## There are 1 condominium units at this address.\n" });
    expect(await resolveAddress(env, { address: "1234 Market St" })).toMatchObject({ resolution: "exact", units: null });
    expect(requested()).toEqual([atlasUrl("1234 Market St")]);
  });

  it("returns no_match with the variants tried after two empty_content answers", async () => {
    mockAtlas({ [atlasUrl("1 nowhere st.")]: EMPTY, [atlasUrl("1 NOWHERE ST")]: EMPTY });
    const res = await resolveAddress(env, { address: "1 nowhere st." }, { sleep });
    expect(res).toEqual({ outcome: "no_match", variants_tried: ["1 nowhere st.", "1 NOWHERE ST"], manual_url: "https://atlas.phila.gov/" });
    // The typed text is read once; only the last form is read again, in case its page was briefly empty.
    expect(requested()).toEqual([atlasUrl("1 nowhere st."), ...Array(1 + FETCH_RETRY_ON_LOADING).fill(atlasUrl("1 NOWHERE ST"))]);
    expect(sleeps).toHaveLength(FETCH_RETRY_ON_LOADING);
  });

  it("returns no_match when the atlas answers 'no property assessment record' instead of empty_content", async () => {
    mockAtlas({ [atlasUrl("100 Main St.")]: fx("property-no-record.md"), [atlasUrl("100 MAIN ST")]: fx("property-no-record.md") });
    const res = await resolveAddress(env, { address: "100 Main St." });
    expect(res).toEqual({ outcome: "no_match", variants_tried: ["100 Main St.", "100 MAIN ST"], manual_url: "https://atlas.phila.gov/" });
  });

  it("recognises the no-record sentence in any case", async () => {
    const page = "Atlas\nThere is NO PROPERTY ASSESSMENT RECORD for this address.\n";
    mockAtlas({ [atlasUrl("100 Main St")]: page });
    expect(await resolveAddress(env, { address: "100 Main St" })).toMatchObject({ outcome: "no_match", variants_tried: ["100 Main St"] });
  });

  it.each([
    ["the recorded 262-character shell of an unrendered route", fx("shell-condominiums.md")],
    ["an empty page", ""],
    ["an H1 without the OPA account", "# 1234 MARKET ST\n\nPHILADELPHIA, PA 19107-3721\n"],
    ["an OPA account without an H1", "| OPA Account # | 883309050 |\n"],
  ])("throws AtlasUnavailableError(unrecognized_page) for %s, not no_match, and tries no other variant", async (_label, text) => {
    const raw = atlasUrl("1234 market st.");
    mockAtlas({ [raw]: text, [atlasUrl("1234 MARKET ST")]: MARKET });
    const err = await resolveAddress(env, { address: "1234 market st." }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasUnavailableError);
    expect(err).toMatchObject({ code: "unrecognized_page", url: raw });
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("moves on to the next variant after a no-record page", async () => {
    mockAtlas({ [atlasUrl("1234 market st.")]: fx("property-no-record.md"), [atlasUrl("1234 MARKET ST")]: MARKET });
    expect(await resolveAddress(env, { address: "1234 market st." })).toMatchObject({ outcome: "resolved", opa_account: "883309050" });
  });

  it("returns no_match for blank input without calling TinyFish", async () => {
    expect(await resolveAddress(env, { address: "  " })).toEqual({ outcome: "no_match", variants_tried: [], manual_url: "https://atlas.phila.gov/" });
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("returns no_match at once for an address with no digit, without a read", async () => {
    expect(await resolveAddress(env, { address: "market st" })).toEqual({
      outcome: "no_match",
      variants_tried: ["market st"],
      manual_url: "https://atlas.phila.gov/",
    });
    expect(fetchMock.calls).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it("retries a transient empty_content on the same variant before moving on", async () => {
    mockAtlas({ [atlasUrl("1234 Market St")]: [EMPTY, MARKET] });
    const res = await resolveAddress(env, { address: "1234 Market St" }, { sleep });
    expect(res).toMatchObject({ outcome: "resolved", opa_account: "883309050" });
    expect(requested()).toEqual([atlasUrl("1234 Market St"), atlasUrl("1234 Market St")]);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS]);
  });

  it("throws AtlasUnavailableError on an HTTP failure and does not try the next variant", async () => {
    const url = atlasUrl("1234 market st.");
    mockAtlas({ [url]: HTTP_500, [atlasUrl("1234 MARKET ST")]: MARKET });
    const err = await resolveAddress(env, { address: "1234 market st." }, { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasUnavailableError);
    expect(err).toMatchObject({ name: "AtlasUnavailableError", code: "internal_error", url });
    expect(fetchMock.calls).toHaveLength(1 + FETCH_RETRY_ON_LOADING);
    expect(requested()).not.toContain(atlasUrl("1234 MARKET ST"));
  });

  it("throws AtlasUnavailableError when the page stays incomplete after the retries", async () => {
    const loading = "# 1234 MARKET ST\n\nLoading buildings\n";
    mockAtlas({ [atlasUrl("1234 Market St")]: loading });
    const err = await resolveAddress(env, { address: "1234 Market St" }, { sleep }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "AtlasUnavailableError", code: "incomplete_after_retries" });
    expect(fetchMock.calls).toHaveLength(4);
  });

  it("throws AtlasUnavailableError on a response with neither a result nor an error", async () => {
    fetchMock.intercept({ method: "POST", url: FETCH_API, times: Infinity, reply: { json: { results: [], errors: [] } } });
    const err = await resolveAddress(env, { address: "1234 Market St" }, { sleep }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "AtlasUnavailableError", code: "no_result" });
  });

  it("resolves an OPA account through /<account>/property as exact", async () => {
    mockAtlas({ [atlasUrl("883309050")]: MARKET });
    const res = await resolveAddress(env, { opa_account: "883309050" });
    expect(res).toMatchObject({
      outcome: "resolved",
      resolution: "exact",
      address_resolved: "1234 MARKET ST",
      opa_account: "883309050",
      units: null,
      variants_tried: ["883309050"],
    });
    expect(requested()).toEqual(["https://atlas.phila.gov/883309050/property"]);
  });

  it("resolves a condominium unit's own OPA account to that unit, not the parent", async () => {
    mockAtlas({ [atlasUrl("875100060")]: fx("property-opa-875100060.md") });
    const res = await resolveAddress(env, { opa_account: "875100060" });
    expect(res).toMatchObject({ outcome: "resolved", resolution: "exact", address_resolved: "1500S MARKET ST", opa_account: "875100060", units: null });
  });

  it("returns no_match when the page for an OPA account shows a different account", async () => {
    mockAtlas({ [atlasUrl("883309051")]: MARKET });
    const res = await resolveAddress(env, { opa_account: "883309051" });
    expect(res).toEqual({ outcome: "no_match", variants_tried: ["883309051"], manual_url: "https://atlas.phila.gov/" });
  });

  it("uses the OPA account when both an address and an account are given", async () => {
    mockAtlas({ [atlasUrl("883309050")]: MARKET });
    await resolveAddress(env, { address: "somewhere else", opa_account: "883309050" });
    expect(requested()).toEqual([atlasUrl("883309050")]);
  });

  it("resolves a supplied unit to that unit's account when the building lists units", async () => {
    mockAtlas({
      [atlasUrl("1500 Market St")]: fx("property-1500-market.md"),
      [atlasUrl("1500 Market St", "condos")]: fx("condos-1500-market.md"),
      [atlasUrl("875100060")]: fx("property-opa-875100060.md"),
    });
    const res = await resolveAddress(env, { address: "1500 Market St", unit: "1500S" });
    expect(res).toMatchObject({
      outcome: "resolved",
      address_resolved: "1500S MARKET ST",
      opa_account: "875100060",
      units: null,
    });
    expect(requested()).toEqual([
      atlasUrl("1500 Market St"),
      atlasUrl("1500 Market St", "condos"),
      atlasUrl("875100060"),
    ]);
  });

  it("picks the matching unit when the unit is written inside the address", async () => {
    mockAtlas({
      [atlasUrl("1500 Market St Apt 1500S")]: fx("property-no-record.md"),
      [atlasUrl("1500 MARKET ST")]: fx("property-1500-market.md"),
      [atlasUrl("1500 MARKET ST", "condos")]: fx("condos-1500-market.md"),
      [atlasUrl("875100060")]: fx("property-opa-875100060.md"),
    });
    const res = await resolveAddress(env, { address: "1500 Market St Apt 1500S" }, { sleep });
    expect(res).toMatchObject({ outcome: "resolved", opa_account: "875100060", address_resolved: "1500S MARKET ST" });
  });

  // 3600 Market St on the live atlas: a condominium building whose /property page has a heading and a
  // unit count and no assessment record of its own. It used to end as "unrecognized_page".
  const BUILDING = "# 3600 MARKET ST\n\nPHILADELPHIA, PA 19104-3284\n\n## There are 3 condominium units at this address.\n\n" +
    "You can use the Condominiums tab below to see information for an individual unit.\n";
  const BUILDING_UNITS = "# 3600 MARKET ST\n\n## Condominiums (3)\n\n| Address | OPA Account # |\n| --- | --- |\n" +
    "| 3600 MARKET ST # 100 | 883076615 |\n| 3600 MARKET ST # 400 | 883076685 |\n| 3600 MARKET ST STE 201 | 883076625 |\n";

  it("answers with the units to choose from when a condominium building has no record of its own", async () => {
    mockAtlas({ [atlasUrl("3600 Market St")]: BUILDING, [atlasUrl("3600 Market St", "condos")]: BUILDING_UNITS });
    expect(await resolveAddress(env, { address: "3600 Market St" })).toEqual({
      outcome: "ambiguous",
      candidates: [
        { address: "3600 MARKET ST # 100", url: atlasUrl("883076615") },
        { address: "3600 MARKET ST # 400", url: atlasUrl("883076685") },
        { address: "3600 MARKET ST STE 201", url: atlasUrl("883076625") },
      ],
      units: { building: "3600 MARKET ST", count: 3, listed: 3, list_url: atlasUrl("3600 Market St", "condos") },
    });
  });

  it("resolves the unit that was named in such a building", async () => {
    mockAtlas({
      [atlasUrl("3600 Market St")]: BUILDING,
      [atlasUrl("3600 Market St", "condos")]: BUILDING_UNITS,
      [atlasUrl("883076685")]: "# 3600 MARKET ST # 400\n\nPHILADELPHIA, PA 19104-3284\n\n| OPA Account # | 883076685 |\n",
    });
    expect(await resolveAddress(env, { address: "3600 Market St", unit: "400" })).toMatchObject({
      outcome: "resolved", address_resolved: "3600 MARKET ST # 400", opa_account: "883076685",
    });
  });

  it("offers no address to choose, and points at the city's own list, when that list cannot be read", async () => {
    mockAtlas({ [atlasUrl("3600 Market St")]: BUILDING, [atlasUrl("3600 Market St", "condos")]: EMPTY });
    expect(await resolveAddress(env, { address: "3600 Market St" }, { sleep })).toEqual({
      outcome: "ambiguous",
      candidates: [],
      units: { building: "3600 MARKET ST", count: 3, listed: 0, list_url: "https://atlas.phila.gov/3600%20Market%20St/condos" },
    });
  });

  // What the live atlas really holds for 3600 Market St (read 11 November 2026): 17 units, of
  // which its list shows the first ten. STE 700 is one of the seven it does not show.
  const REAL = { [atlasUrl("3600 Market St")]: fx("property-3600-market.md"), [atlasUrl("3600 Market St", "condos")]: fx("condos-3600-market.md") };

  it("says how many units the building has when the city's list shows only some of them", async () => {
    mockAtlas(REAL);
    const res = await resolveAddress(env, { address: "3600 Market St" });
    expect(res).toMatchObject({ outcome: "ambiguous", units: { building: "3600 MARKET ST", count: 17, listed: 10 } });
    expect(res.outcome === "ambiguous" && res.candidates).toHaveLength(10);
  });

  it("resolves a named unit the city's list does not show, by asking the atlas for the unit itself", async () => {
    mockAtlas({ ...REAL, [atlasUrl("3600 MARKET ST Unit 700")]: fx("property-3600-market-ste-700.md") });
    expect(await resolveAddress(env, { address: "3600 Market St", unit: "Suite 700" })).toMatchObject({
      outcome: "resolved", address_resolved: "3600 MARKET ST STE 700", opa_account: "883076625", units: null,
    });
    expect(requested()).toEqual([atlasUrl("3600 Market St"), atlasUrl("3600 Market St", "condos"), atlasUrl("3600 MARKET ST Unit 700")]);
  });

  it("does not take the building's own page for a unit that does not exist", async () => {
    // The atlas answers an unknown unit with the building's page.
    mockAtlas({ ...REAL, [atlasUrl("3600 MARKET ST Unit 500")]: fx("property-3600-market.md") });
    const res = await resolveAddress(env, { address: "3600 Market St", unit: "500" });
    expect(res).toMatchObject({ outcome: "ambiguous", units: { count: 17, listed: 10, not_found: "500" } });
  });

  it("says the atlas did not find a unit typed in the address, without asking for it twice", async () => {
    // "3600 Market St Unit 999" is answered with the building's page: the atlas knows no such unit.
    mockAtlas({ [atlasUrl("3600 Market St Unit 999")]: fx("property-3600-market.md"), [atlasUrl("3600 MARKET ST", "condos")]: fx("condos-3600-market.md") });
    const res = await resolveAddress(env, { address: "3600 Market St Unit 999" });
    expect(res).toMatchObject({
      outcome: "ambiguous",
      units: { building: "3600 MARKET ST", count: 17, listed: 10, not_found: "999", list_url: atlasUrl("3600 MARKET ST", "condos") },
    });
    // The list is read at the building's own address, and the unit is not asked for a second time.
    expect(requested()).toEqual([atlasUrl("3600 Market St Unit 999"), atlasUrl("3600 MARKET ST", "condos")]);
  });

  it("answers with the units when the read of the named unit fails", async () => {
    mockAtlas({ ...REAL, [atlasUrl("3600 MARKET ST Unit 700")]: HTTP_500 });
    const res = await resolveAddress(env, { address: "3600 Market St", unit: "700" }, { sleep });
    expect(res).toMatchObject({ outcome: "ambiguous", units: { listed: 10 } });
    // A read that failed says nothing about whether the unit exists.
    expect(res.outcome === "ambiguous" && res.units?.not_found).toBeUndefined();
  });

  it("reads the unit list again when the city's site answers unreachable", async () => {
    mockAtlas({ [atlasUrl("3600 Market St")]: fx("property-3600-market.md"), [atlasUrl("3600 Market St", "condos")]: [UNREACHABLE, fx("condos-3600-market.md")] });
    const res = await resolveAddress(env, { address: "3600 Market St" }, { sleep });
    expect(res.outcome === "ambiguous" && res.candidates).toHaveLength(10);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS]);
  });

  it("reads the unit list again when the page comes back without its table", async () => {
    const noTable = "# 3600 MARKET ST\n\nPHILADELPHIA, PA 19104-3284\n\nCondominium units at your search address, as recorded for property assessment purposes.\n";
    mockAtlas({ [atlasUrl("3600 Market St")]: fx("property-3600-market.md"), [atlasUrl("3600 Market St", "condos")]: [noTable, fx("condos-3600-market.md")] });
    const res = await resolveAddress(env, { address: "3600 Market St" }, { sleep });
    expect(res.outcome === "ambiguous" && res.candidates).toHaveLength(10);
  });

  it("resolves a named unit even when the unit list cannot be read", async () => {
    mockAtlas({
      [atlasUrl("3600 Market St")]: fx("property-3600-market.md"),
      [atlasUrl("3600 Market St", "condos")]: UNREACHABLE,
      [atlasUrl("3600 MARKET ST Unit 700")]: fx("property-3600-market-ste-700.md"),
    });
    expect(await resolveAddress(env, { address: "3600 Market St", unit: "700" }, { sleep })).toMatchObject({ outcome: "resolved", opa_account: "883076625" });
  });

  it("asks for a named unit again when the city's site answers unreachable", async () => {
    // Seen on 12 November: the atlas answered "unreachable" for unit 800 a moment after serving the building.
    const unit800 = fx("property-3600-market-ste-700.md").replaceAll("STE 700", "STE 800");
    mockAtlas({ ...REAL, [atlasUrl("3600 MARKET ST Unit 800")]: [UNREACHABLE, unit800] });
    expect(await resolveAddress(env, { address: "3600 Market St", unit: "800" }, { sleep })).toMatchObject({
      outcome: "resolved", address_resolved: "3600 MARKET ST STE 800",
    });
  });

  it("answers ambiguous with the unit list when the building lists units and none match", async () => {
    mockAtlas({
      [atlasUrl("1500 Market St")]: fx("property-1500-market.md"),
      [atlasUrl("1500 Market St", "condos")]: fx("condos-1500-market.md"),
      // The atlas answers a unit it does not know with the building's page, which has an account of its own.
      [atlasUrl("1500 MARKET ST Unit 4B")]: fx("property-1500-market.md"),
    });
    expect(await resolveAddress(env, { address: "1500 Market St", unit: "4B" })).toEqual({
      outcome: "ambiguous",
      candidates: [
        { address: "1500-42 MARKET ST", url: atlasUrl("883320000") },
        { address: "1500S MARKET ST", url: atlasUrl("875100060") },
      ],
      units: { building: "1500 MARKET ST", count: 2, listed: 2, list_url: atlasUrl("1500 Market St", "condos"), not_found: "4B" },
    });
  });

  it("does not take a unit whose number only ends with the one asked for", async () => {
    // "2" is not unit "42" of "1500-42 MARKET ST", and "1500" alone names the building, not a unit.
    for (const unit of ["2", "1500"]) {
      mockAtlas({
        [atlasUrl("1500 Market St")]: fx("property-1500-market.md"),
        [atlasUrl("1500 Market St", "condos")]: fx("condos-1500-market.md"),
        [atlasUrl("1500 MARKET ST Unit 2")]: fx("property-1500-market.md"),
      });
      expect(await resolveAddress(env, { address: "1500 Market St", unit })).toMatchObject({ outcome: "ambiguous" });
    }
  });

  it("resolves as the parent when a unit is given but the building has no unit list", async () => {
    mockAtlas({ [atlasUrl("2140 Spruce St")]: MARKET });
    const res = await resolveAddress(env, { address: "2140 Spruce St", unit: "4B" });
    expect(res).toMatchObject({ outcome: "resolved", opa_account: "883309050", units: null });
    expect(requested()).toEqual([atlasUrl("2140 Spruce St")]);
  });
});

describe("parseCondoUnits", () => {
  it("reads the Address and OPA Account # table of the recorded condos tab", () => {
    expect(parseCondoUnits(fx("condos-1500-market.md"))).toEqual([
      { address: "1500-42 MARKET ST", opa_account: "883320000" },
      { address: "1500S MARKET ST", opa_account: "875100060" },
    ]);
  });

  it("returns an empty list for text without the table", () => {
    expect(parseCondoUnits(fx("property-no-record.md"))).toEqual([]);
  });
});
