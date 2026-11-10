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
  | { outcome: "ambiguous"; candidates: { address: string; url: string }[] };

const NO_RECORD = /no property assessment record/i;

/** The H1 address and the OPA account of a /property page; null for any other page (for example "no property assessment record"). */
function readProperty(text: string): { h1: string; opa: string } | null {
  const h1 = /^# (.+)$/m.exec(text)?.[1]?.trim();
  const opa = /\|\s*OPA Account #\s*\|\s*(\d{9})\s*\|/.exec(text)?.[1];
  return h1 && opa ? { h1, opa } : null;
}

/** N from "There are N condominium units" or "There are N active parcels" when N > 1. */
function unitCount(text: string): number | null {
  for (const pattern of [/There are (\d+) condominium units/, /There are (\d+) active parcels/]) {
    const n = Number(pattern.exec(text)?.[1]);
    if (n > 1) return n;
  }
  return null;
}

/** The condominium parent's units: the count from /property, the list from the atlas condos tab. A failed read, or a page with no unit table, leaves `list` null; it never fails the resolution. */
async function readUnits(env: Env, address: string, count: number, opts: { sleep?: (ms: number) => Promise<void> }): Promise<Units> {
  const tab = await fetchAtlas(env, address, "condos", opts);
  const list = tab.ok ? parseCondoUnits(tab.text) : [];
  return { count, list: list.length > 0 ? list : null, list_url: tab.url };
}

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
        const units = await readUnits(env, variant, unitsHere, opts);
        const named = (input.unit?.trim() || (input.address ? normalizeAddress(input.address).unit : null)) ?? null;
        if (units.list === null) {
          return { outcome: "ambiguous", candidates: [{ address: `${building} (${unitsHere} condominium units)`,
            url: units.list_url ?? atlasUrl(variant, "condos") }] };
        }
        const matches = named ? units.list.filter((u) => unitMatches(named, u)) : [];
        if (matches.length === 1) return resolveUnitParcel(env, matches[0]!, tried, input.address ?? "", opts);
        return {
          outcome: "ambiguous",
          candidates: units.list.map((u) => ({ address: u.address, url: atlasUrl(u.opa_account, "property") })),
        };
      }
      throw new AtlasUnavailableError("unrecognized_page", res.url);
    }
    // For an account lookup, a page that shows another account is not the parcel asked for.
    if (byAccount && page.opa !== account) continue;

    const count = unitCount(res.text);
    const units = count !== null ? await readUnits(env, byAccount ? page.h1 : variant, count, opts) : null;
    const wanted = (input.unit?.trim() || (input.address ? normalizeAddress(input.address).unit : null)) ?? null;
    // A supplied unit picks that unit's account when the building lists units; a building with no list stays the parent.
    if (!byAccount && wanted && units?.list && units.list.length > 0) {
      const matches = units.list.filter((u) => unitMatches(wanted, u));
      if (matches.length === 1) {
        return resolveUnitParcel(env, matches[0]!, tried, input.address ?? "", opts);
      }
      return {
        outcome: "ambiguous",
        candidates: units.list.map((u) => ({ address: u.address, url: atlasUrl(u.opa_account, "property") })),
      };
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

/**
 * True when this list row is the supplied unit number (case and punctuation ignored). The unit must
 * equal a whole word of the row: "4" is not unit "14", and the house number alone names no unit
 * unless it carries a letter ("1500S").
 */
function unitMatches(want: string, unit: CondoUnit): boolean {
  const needle = unitKey(want.replace(/^(?:APT|APARTMENT|UNIT|STE|SUITE)\b/i, ""));
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
