// Address handling for the atlas lookup (spec 4.1 step 1 and step 4). The atlas rejects a
// trailing period and an appended city/state/ZIP with empty_content, so lookups try the raw
// input first and the normalized street second.

export interface NormalizedAddress {
  /** Uppercase street address in the city's forms, without city, state, ZIP or unit. */
  street: string;
  /** Unit from `#4B`, `Unit 4B`, `Apt 4B`, `Ste 200`, `Suite 200`, uppercase; null when there is none. */
  unit: string | null;
  /** What the report shows: the street only. The unit is carried separately. */
  display: string;
}

/** Spec 4.1 step 1: full word to the city's form. Suffixes apply to the last token, directions to the first street token. */
const SUFFIXES: Record<string, string> = {
  STREET: "ST",
  AVENUE: "AVE",
  BOULEVARD: "BLVD",
  ROAD: "RD",
  DRIVE: "DR",
  LANE: "LN",
  PLACE: "PL",
  COURT: "CT",
  TERRACE: "TER",
  PARKWAY: "PKWY",
  SQUARE: "SQ",
};
const DIRECTIONS: Record<string, string> = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };

const SUFFIX_FORMS = new Set(Object.values(SUFFIXES));
const STATES = new Set(["PA", "PENNSYLVANIA"]);
const ZIP = /^(\d{5}(-\d{4})?|\d{9})$/;
// A keyword needs a word boundary after it ("1234 W STEWART" is not unit WART); a # may touch the street ("ST#4B").
const UNIT = /(?:\s+(?:UNIT|APT|APARTMENT|STE|SUITE)\b\s*#?\s*|\s*#\s*)([A-Z0-9][A-Z0-9-]*)$/;

/**
 * Removes a trailing ZIP, state and city, in any order and number. The house number and one street
 * token always stay, so a street named like a tail word ("123 Pennsylvania") is kept.
 */
function stripTail(tokens: string[]): string[] {
  const out = [...tokens];
  const keep = /^\d/.test(out[0] ?? "") ? 2 : 1;
  while (out.length > keep) {
    const last = out[out.length - 1]!;
    if (STATES.has(last) || last === "PHILADELPHIA" || ZIP.test(last)) out.pop();
    else break;
  }
  return out;
}

/** Splits "1234 MARKET ST" into the house number (empty when the input has none) and the street tokens. */
function splitNumber(tokens: string[]): { number: string[]; body: string[] } {
  return /^\d/.test(tokens[0] ?? "") ? { number: [tokens[0]!], body: tokens.slice(1) } : { number: [], body: tokens };
}

/** Suffix word to the city's form on the last token; direction word to its letter on the first street token. */
function mapForms(tokens: string[]): string[] {
  const { number, body } = splitNumber(tokens);
  // A suffix or direction word is only a suffix or direction when a street name remains beside it
  // ("1234 Lane St", "1234 North Street" and "12 Court" keep their names).
  if (body.length >= 2) {
    const last = SUFFIXES[body[body.length - 1]!];
    if (last) body[body.length - 1] = last;
  }
  const hasSuffix = body.length >= 2 && SUFFIX_FORMS.has(body[body.length - 1]!);
  if (body.length - (hasSuffix ? 1 : 0) >= 2) {
    const first = DIRECTIONS[body[0]!];
    if (first) body[0] = first;
  }
  return [...number, ...body];
}

export function normalizeAddress(input: string): NormalizedAddress {
  // Commas and periods are only punctuation here ("St.", "Philadelphia,"); the atlas wants none.
  const words = (s: string) => s.replace(/[.,;]+/g, " ").toUpperCase().split(/\s+/).filter(Boolean);

  let tokens = stripTail(words(input));

  let unit: string | null = null;
  const joined = tokens.join(" ");
  const match = UNIT.exec(joined);
  // A unit keyword needs a house number and a street before it ("100 SUITE ST" is a street).
  if (match && joined.slice(0, match.index).split(" ").length >= 2) {
    unit = match[1]!;
    tokens = stripTail(words(joined.slice(0, match.index)));
  }

  tokens = mapForms(tokens);

  const street = tokens.join(" ");
  return { street, unit, display: street };
}

/** Raw trimmed input first, then the normalized street; blanks removed, duplicates (ignoring case) removed. */
export function addressVariants(input: string): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const candidate of [input.trim(), normalizeAddress(input).street]) {
    const key = candidate.toUpperCase();
    if (candidate === "" || seen.has(key)) continue;
    seen.add(key);
    variants.push(candidate);
  }
  return variants;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** House number, street name (without suffix) and suffix of a normalized street. */
function streetParts(street: string): { number: string; name: string; suffix: string | null } {
  const { number, body } = splitNumber(street.split(" ").filter(Boolean));
  const last = body[body.length - 1];
  const suffix = body.length >= 2 && last !== undefined && SUFFIX_FORMS.has(last) ? body.pop()! : null;
  return { number: number[0] ?? "", name: body.join(" "), suffix };
}

/**
 * Spec 4.1 step 4. "fuzzy" when the atlas matched something other than what was typed:
 * a different house number, a street name whose Levenshtein ratio (1 - distance / longer length)
 * is below 0.9, or two different suffixes. A missing suffix, the full word against its
 * abbreviation, and case differences are not fuzzy.
 */
export function compareResolved(input: string, h1: string): "exact" | "fuzzy" {
  const a = streetParts(normalizeAddress(input).street);
  const b = streetParts(normalizeAddress(h1).street);
  if (a.number !== b.number) return "fuzzy";
  if (a.suffix !== null && b.suffix !== null && a.suffix !== b.suffix) return "fuzzy";
  const longest = Math.max(a.name.length, b.name.length);
  const ratio = longest === 0 ? 1 : 1 - levenshtein(a.name, b.name) / longest;
  return ratio < 0.9 ? "fuzzy" : "exact";
}

