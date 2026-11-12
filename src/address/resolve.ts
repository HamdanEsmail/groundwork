// Address resolution (spec 4.1): atlas /property through TinyFetch, raw input first, then the
// normalized street. Reads the H1 address and the OPA account, and recognises a condominium parent.
import type { Env } from "../env";
import { tableCells } from "../sections/markdown";
import { atlasUrl, fetchAtlas } from "../tinyfish/fetch";
import { addressVariants, compareResolved, normalizeAddress } from "./normalize";

const ATLAS_HOME = "https://atlas.phila.gov/";

/** The atlas could not be read (an HTTP failure, a network failure, a page that stayed incomplete, a page that is not a property page). Task 6 answers 502; it is not a no_match. */
export class AtlasUnavailableError extends Error {
  readonly code: string;
  readonly url: string;

  constructor(code: string, url: string) {
    super(`Atlas read failed: ${code} (${url})`);
    this.name = "AtlasUnavailableError";
    this.code = code;
    this.url = url;
  }
}

export interface CondoUnit {
  address: string;
  opa_account: string;
}

export interface Units {
  count: number;
  /** The units on the atlas condos tab; null when that tab could not be read or held no unit table. */
  list: CondoUnit[] | null;
  /** The atlas condominiums tab for this address. */
  list_url: string | null;
  kind?: "condominium_units" | "active_parcels";
}

export interface ResolveInput {
  address?: string;
  opa_account?: string;
  /** Unit number; after the parent is read, matched against the condominium list. */
  unit?: string;
}

export type ResolveResult =
  | {
      outcome: "resolved";
      resolution: "exact" | "fuzzy" | "parent";
      address_resolved: string;
      opa_account: string;
      units: Units | null;
      /** The /property page as read, so the property section does not fetch it again. */
      property_text: string;
      variants_tried: string[];
    }
  | { outcome: "no_match"; variants_tried: string[]; manual_url: string }
  | { outcome: "ambiguous"; candidates: { address: string; url: string }[]; units?: UnitsListed };

/** For a building whose units are offered to choose from: how many it has, and how many of them the city's list showed. */
export interface UnitsListed {
  building: string;
  count: number;
  listed: number;
  list_url: string;
  /** The unit that was asked for, when the atlas answered it with the building's own page. */
  not_found?: string;
}

const NO_RECORD = /no property assessment record/i;

/** The H1 address and the OPA account of a /property page; null for any other page (for example "no property assessment record"). */
function readProperty(text: string): { h1: string; opa: string } | null {
  const h1 = /^# (.+)$/m.exec(text)?.[1]?.trim();
  const opa = /\|\s*OPA Account #\s*\|\s*(\d{9})\s*\|/.exec(text)?.[1];
  return h1 && opa ? { h1, opa } : null;
}

const CONDOMINIUM_UNITS = /There are (\d+) condominium units/;

/** N from "There are N condominium units" or "There are N active parcels" when N > 1. */
function unitCount(text: string): number | null {
  for (const pattern of [CONDOMINIUM_UNITS, /There are (\d+) active parcels/]) {
    const n = Number(pattern.exec(text)?.[1]);
    if (n > 1) return n;
  }
  return null;
}

/**
 * The condominium parent's units: the count from /property, the list from the atlas condos tab.
 * A failed read, or a page with no unit table, leaves `list` null; it never fails the resolution.
 * `propertyText` is the /property page that gave the count. When it says "condominium units",
 * the tab must hold a unit table: the atlas sometimes answers that tab "unreachable", or serves
 * it before the table is in it, a moment after serving /property for the same address. Both are
 * read again before the list is given up.
 */
async function readUnits(env: Env, address: string, count: number, propertyText: string, opts: { sleep?: (ms: number) => Promise<void> }): Promise<Units> {
  const expectsTable = CONDOMINIUM_UNITS.test(propertyText);
  const tab = await fetchAtlas(env, address, "condos", expectsTable
    ? { ...opts, retryUnreachable: true, holds: (text) => parseCondoUnits(text).length > 0 }
    : opts);
  const list = tab.ok ? parseCondoUnits(tab.text) : [];
  return { count, list: list.length > 0 ? list : null, list_url: tab.url };
}

/** The answer that offers a building's units to choose from. With no list read, there is no address to offer. */
function chooseUnit(building: string, units: Units, fallbackUrl: string, notFound: string | null = null): ResolveResult {
  const list = units.list ?? [];
  return {
    outcome: "ambiguous",
    candidates: list.map((u) => ({ address: u.address, url: atlasUrl(u.opa_account, "property") })),
    units: { building, count: units.count, listed: list.length, list_url: units.list_url ?? fallbackUrl, ...(notFound ? { not_found: notFound } : {}) },
  };
}

/** How asking the atlas for one unit ended: the unit's own record, "the atlas knows no such unit", or null when the read says nothing. */
type NamedUnit = ResolveResult | "not_found" | null;

export async function resolveAddress(
  env: Env,
  input: ResolveInput,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<ResolveResult> {
  const account = input.opa_account?.trim() ?? "";
  const byAccount = account !== "";
  // An address with no digit cannot name a property; do not ask the atlas whether the city site is down.
  if (!byAccount) {
    const cleaned = (input.address ?? "").trim();
    if (cleaned !== "" && !/\d/.test(cleaned)) {
      return { outcome: "no_match", variants_tried: [cleaned], manual_url: ATLAS_HOME };
    }
  }
  const variants = byAccount ? [account] : addressVariants(input.address ?? "");
  const tried: string[] = [];

  for (const [i, variant] of variants.entries()) {
    tried.push(variant);
    // The atlas answers the text as typed (a trailing period, a city and ZIP) with an empty page. That
    // is a definite miss, so the cleaned form is tried at once. Only the last form is read again when
    // it comes back empty, in case its page was briefly empty.
    const res = await fetchAtlas(env, variant, "property", { ...opts, emptyIsFinal: i < variants.length - 1 });
    if (!res.ok) {
      if (res.error === "empty_content") continue;
      throw new AtlasUnavailableError(res.error, res.url);
    }
    const page = readProperty(res.text);
    if (page === null) {
      // Only the atlas's own "no property assessment record" page is a miss. Any other page without an
      // H1 and an account (a shell served before the page rendered, an empty body) says nothing about
      // the address, so it is an error, not a no_match that would be stored as a failed dossier.
      if (NO_RECORD.test(res.text)) continue;
      // A condominium building can have a heading and a unit count and no assessment record of its
      // own. Its units are the properties: the named unit is resolved, otherwise the units are offered.
      const building = /^# (.+)$/m.exec(res.text)?.[1]?.trim();
      const unitsHere = unitCount(res.text);
      if (!byAccount && building && unitsHere !== null) {
        // When the address that was asked carries a unit, the list is read at the building's own address.
        const typedUnit = normalizeAddress(variant).unit;
        const listAt = typedUnit ? building : variant;
        const units = await readUnits(env, listAt, unitsHere, res.text, opts);
        const named = (input.unit?.trim() || (input.address ? normalizeAddress(input.address).unit : null)) ?? null;
        const matches = named && units.list ? units.list.filter((u) => unitMatches(named, u)) : [];
        if (matches.length === 1) return resolveUnitParcel(env, matches[0]!, tried, input.address ?? "", opts);
        // The city's list shows only its first rows, and may not have been read at all, so the unit is
        // asked of the atlas itself: unless this very page is its answer for that unit.
        const answered = named !== null && typedUnit !== null && unitNeedle(typedUnit) === unitNeedle(named);
        const direct: NamedUnit = named === null ? null : answered ? "not_found" : await readNamedUnit(env, building, named, tried, input.address ?? "", opts);
        if (direct !== null && direct !== "not_found") return direct;
        return chooseUnit(building, units, atlasUrl(listAt, "condos"), direct === "not_found" && named ? unitNeedle(named) : null);
      }
      throw new AtlasUnavailableError("unrecognized_page", res.url);
    }
    // For an account lookup, a page that shows another account is not the parcel asked for.
    if (byAccount && page.opa !== account) continue;

    const count = unitCount(res.text);
    const typedUnit = byAccount ? null : normalizeAddress(variant).unit;
    const listAt = byAccount || typedUnit ? page.h1 : variant;
    const units = count !== null ? await readUnits(env, listAt, count, res.text, opts) : null;
    const wanted = (input.unit?.trim() || (input.address ? normalizeAddress(input.address).unit : null)) ?? null;
    // A supplied unit picks that unit's account when the building lists units; a building with no list stays the parent.
    if (!byAccount && wanted && units !== null) {
      const matches = (units.list ?? []).filter((u) => unitMatches(wanted, u));
      if (matches.length === 1) {
        return resolveUnitParcel(env, matches[0]!, tried, input.address ?? "", opts);
      }
      const answered = typedUnit !== null && unitNeedle(typedUnit) === unitNeedle(wanted);
      const direct: NamedUnit = answered ? "not_found" : await readNamedUnit(env, page.h1, wanted, tried, input.address ?? "", opts);
      if (direct !== null && direct !== "not_found") return direct;
      // A building whose list could not be read stays the parent; one that lists its units offers them.
      if (units.list !== null) return chooseUnit(page.h1, units, atlasUrl(listAt, "condos"), direct === "not_found" ? unitNeedle(wanted) : null);
    }
    return {
      outcome: "resolved",
      // A parent wins over fuzzy: the banner about units matters more than the spelling.
      resolution: count !== null ? "parent" : byAccount ? "exact" : compareResolved(input.address ?? "", page.h1),
      address_resolved: page.h1,
      opa_account: page.opa,
      // The condos tab is read at the address that served /property; an account lookup uses the H1 address.
      units,
      property_text: res.text,
      variants_tried: tried,
    };
  }
  return { outcome: "no_match", variants_tried: tried, manual_url: ATLAS_HOME };
}

/** Letters and digits only, so "#4B", "Apt 4B" and "4-B" compare equal. */
function unitKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The unit as asked for, without the word in front of it: "Suite 700" and "#700" are both 700. */
function unitNeedle(want: string): string {
  return unitKey(want.replace(/^(?:APT|APARTMENT|UNIT|STE|SUITE)\b/i, ""));
}

/**
 * Asks the atlas for the unit itself. It resolves "<building> Unit <n>" for every unit of a
 * building, including the ones its list does not show. It answers a unit it does not know with
 * the building's own page, which can carry an account of its own, so the page is taken only
 * when its heading is not the building's and carries the unit. "not_found" when the atlas
 * answered with the building's page: it knows no such unit. Null when the read failed or says
 * nothing either way; the caller then offers the units to choose from.
 */
async function readNamedUnit(
  env: Env,
  building: string,
  named: string,
  variantsTried: string[],
  searched: string,
  opts: { sleep?: (ms: number) => Promise<void> },
): Promise<NamedUnit> {
  const needle = unitNeedle(named);
  // The house number alone names the building, not a unit.
  if (!needle || needle === unitKey(building.split(/\s+/)[0] ?? "")) return null;
  const address = `${building} Unit ${needle}`;
  // The atlas has just served the building at this address, so "unreachable" here is a passing failure.
  const res = await fetchAtlas(env, address, "property", { ...opts, retryUnreachable: true });
  if (!res.ok) return null;
  const page = readProperty(res.text);
  const heading = page?.h1 ?? /^# (.+)$/m.exec(res.text)?.[1]?.trim() ?? null;
  if (heading !== null && unitKey(heading) === unitKey(building)) return "not_found";
  if (page === null || !unitMatches(named, { address: page.h1, opa_account: page.opa })) return null;
  return {
    outcome: "resolved",
    resolution: searched ? compareResolved(searched, page.h1) : "exact",
    address_resolved: page.h1,
    opa_account: page.opa,
    units: null,
    property_text: res.text,
    variants_tried: [...variantsTried, address],
  };
}

/**
 * True when this list row is the supplied unit number (case and punctuation ignored). The unit must
 * equal a whole word of the row: "4" is not unit "14", and the house number alone names no unit
 * unless it carries a letter ("1500S").
 */
function unitMatches(want: string, unit: CondoUnit): boolean {
  const needle = unitNeedle(want);
  if (!needle) return false;
  const words = unit.address.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w !== "");
  if (words.slice(1).includes(needle)) return true;
  return words[0] === needle && /[A-Z]/.test(needle);
}

/** Reads the unit's own /property page and resolves to that account. */
async function resolveUnitParcel(
  env: Env,
  unit: CondoUnit,
  variantsTried: string[],
  searched: string,
  opts: { sleep?: (ms: number) => Promise<void> },
): Promise<ResolveResult> {
  const res = await fetchAtlas(env, unit.opa_account, "property", opts);
  if (!res.ok) throw new AtlasUnavailableError(res.error, res.url);
  const page = readProperty(res.text);
  if (page === null) {
    if (NO_RECORD.test(res.text)) {
      return { outcome: "no_match", variants_tried: variantsTried, manual_url: ATLAS_HOME };
    }
    throw new AtlasUnavailableError("unrecognized_page", res.url);
  }
  return {
    outcome: "resolved",
    resolution: searched ? compareResolved(searched, page.h1) : "exact",
    address_resolved: page.h1,
    opa_account: page.opa,
    units: null,
    property_text: res.text,
    variants_tried: variantsTried,
  };
}

/** Rows of the atlas condos tab table (`| Address | OPA Account # |`). */
export function parseCondoUnits(text: string): CondoUnit[] {
  const units: CondoUnit[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    const cells = tableCells(line);
    if (cells === null) {
      inTable = false;
    } else if (cells[0] === "Address" && cells[1] === "OPA Account #") {
      inTable = true;
    } else if (inTable && cells.length === 2 && /^\d{9}$/.test(cells[1]!) && cells[0] !== "") {
      units.push({ address: cells[0]!, opa_account: cells[1]! });
    }
  }
  return units;
}
