// Assessment and sale: atlas /property (Office of Property Assessment). Monitorable.
import { atlasUrl } from "../tinyfish/fetch";
import { UnrecognisedPage, displayDate, measure, orNull, orUnrecognised, pageKeyValues, pageTitle, splitSections, usDate, usd, valueOf } from "./markdown";
import type { PropertyData, SectionAdapter, SectionEvent } from "./types";

/** Owners and mailing lines share one cell, separated by runs of two or more spaces. */
function splitLines(raw: string | null): string[] {
  return raw === null ? [] : raw.split(/\s{2,}/).map((s) => s.trim()).filter((s) => s !== "");
}

/** The cell without its trailing link text. */
function stripLinkText(raw: string | null, link: RegExp): string | null {
  if (raw === null) return null;
  return raw.replace(link, "").trim();
}

function homestead(raw: string | null): boolean | null {
  if (raw === null) return null;
  if (/does not have the homestead exemption/i.test(raw)) return false;
  if (/has the homestead exemption/i.test(raw)) return true;
  return null;
}

/** A year as the city writes it: four digits, with "(estimated)" after it for many older houses. */
const ESTIMATED_YEAR = /^(\d{4})(\s*\(estimated\))?$/i;

/**
 * The year a building went up, and whether the city calls it an estimate. Read from the parsed
 * year, or from the city's own text for a report stored before estimated years were kept.
 */
export function builtYear(d: Pick<PropertyData, "year_built" | "year_built_estimated" | "raw"> | null | undefined): { year: number; estimated: boolean } | null {
  if (!d) return null;
  if (d.year_built != null) return { year: d.year_built, estimated: d.year_built_estimated === true };
  const m = ESTIMATED_YEAR.exec(d.raw?.year_built?.trim() ?? "");
  return m !== null && m[2] !== undefined && Number(m[1]) > 0 ? { year: Number(m[1]), estimated: true } : null;
}

function readProperty(markdown: string): PropertyData {
  const kv = pageKeyValues(splitSections(markdown));
  const get = (key: string) => valueOf(kv, key);
  // The anchors of a /property page: the H1 address and the "OPA Account #" row.
  const account = orNull(get("OPA Account #"));
  if (pageTitle(markdown) === null || account === null) throw new UnrecognisedPage("property: no H1 address or OPA Account #");
  const yearRaw = get("Year Built");
  const yearText = ESTIMATED_YEAR.exec(yearRaw?.trim() ?? "");
  const year = yearText !== null && Number(yearText[1]) > 0 ? Number(yearText[1]) : null;
  const estimated = year !== null && yearText?.[2] !== undefined;
  const assessedRaw = stripLinkText(get("Assessed Value"), /\s*View tax balance & pay bill\s*$/i);
  const homesteadRaw = stripLinkText(get("Homestead Exemption"), /\s*Learn about property tax programs\s*$/i);
  const units = /There (?:are|is) (\d+) condominium units?\b/i.exec(markdown);
  const raw: PropertyData["raw"] = {
    owners: get("Owners"),
    mailing_address: get("Mailing Address"),
    year_built: yearRaw,
    improvement_area_sqft: get("Improvement Area"),
    assessed_value_usd: assessedRaw,
    homestead: homesteadRaw,
    sale_date: get("Sale Date"),
    sale_price_usd: get("Sale Price"),
  };
  return {
    opa_account: account,
    opa_address: orNull(get("OPA Address")),
    owners: splitLines(raw.owners),
    mailing_address: splitLines(raw.mailing_address),
    building_description: orNull(get("Building Description")),
    year_built: year,
    ...(estimated ? { year_built_estimated: true } : {}),
    improvement_area_sqft: measure(raw.improvement_area_sqft, "sq ft"),
    assessed_value_usd: usd(raw.assessed_value_usd),
    homestead: homestead(homesteadRaw),
    sale_date: usDate(raw.sale_date),
    sale_price_usd: usd(raw.sale_price_usd),
    units_notice: units === null ? null : Number(units[1]),
    raw,
  };
}

/** The section's data, or null when the text is not a /property page (no H1 address, no OPA Account # row). */
export function parseProperty(markdown: string): PropertyData | null {
  return orUnrecognised(() => readProperty(markdown));
}

const money = (n: number, raw: string | null): string => (raw !== null && usd(raw) === n ? raw : `$${n.toLocaleString("en-US")}`);

/** Owners as compared: trimmed, one space between words, uppercase, order ignored. */
const ownerKey = (d: PropertyData) =>
  d.owners
    .map((o) => o.trim().replace(/\s+/g, " ").toUpperCase())
    .sort()
    .join("|");

/**
 * Events between two recognised /property reads. A field is compared only when both reads have it,
 * so a value one read could not parse (or an earlier read that never had a sale) is never a change.
 * `assessment_change` when the assessed value differs; `sale` when the sale date or the sale price
 * differs; `other` ("Owner changed ...") when both reads name owners and the owners differ, in any
 * order.
 */
export function diffProperty(before: PropertyData, after: PropertyData): SectionEvent[] {
  const events: SectionEvent[] = [];
  const differs = <T>(a: T | null, b: T | null) => a !== null && b !== null && a !== b;

  if (differs(before.assessed_value_usd, after.assessed_value_usd)) {
    const was = { assessed_value_usd: before.assessed_value_usd, raw: before.raw.assessed_value_usd };
    const now = { assessed_value_usd: after.assessed_value_usd, raw: after.raw.assessed_value_usd };
    events.push({
      kind: "assessment_change",
      summary: `Assessed value now ${money(after.assessed_value_usd!, now.raw)} (was ${money(before.assessed_value_usd!, was.raw)}).`,
      rows: [now],
      before: was,
      after: now,
    });
  }

  if (differs(before.sale_date, after.sale_date) || differs(before.sale_price_usd, after.sale_price_usd)) {
    const sale = (d: PropertyData) => ({
      sale_date: d.sale_date,
      sale_price_usd: d.sale_price_usd,
      raw: { sale_date: d.raw.sale_date, sale_price_usd: d.raw.sale_price_usd },
    });
    const when = after.sale_date !== null ? ` dated ${displayDate(after.sale_date)}` : "";
    const price = after.sale_price_usd !== null ? ` for ${money(after.sale_price_usd, after.raw.sale_price_usd)}` : "";
    events.push({ kind: "sale", summary: `Sale${when}${price}.`, rows: [sale(after)], before: sale(before), after: sale(after) });
  }

  if (before.owners.length > 0 && after.owners.length > 0 && ownerKey(before) !== ownerKey(after)) {
    const owners = (d: PropertyData) => ({ owners: d.owners, raw: d.raw.owners });
    events.push({
      kind: "other",
      summary: `Owner changed from ${before.owners.join(" and ")} to ${after.owners.join(" and ")}.`,
      rows: [owners(after)],
      before: owners(before),
      after: owners(after),
    });
  }
  return events;
}

export const propertyAdapter: SectionAdapter<PropertyData> = {
  id: "property",
  label: "Assessment and sale",
  agency: "Office of Property Assessment",
  method: "fetch",
  monitorable: true,
  purpose: "The assessed value, owner, sale date or sale price changed.",
  url: (ctx) => atlasUrl(ctx.address, "property"),
  parse: parseProperty,
  diff: diffProperty,
};
