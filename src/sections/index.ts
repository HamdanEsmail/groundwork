// The nine sections in sheet order (C1): four free atlas reads, then the Agent reads.
import { assessmentHistoryAdapter } from "./assessmentHistory";
import { deedsAdapter } from "./deeds";
import { floodAdapter } from "./flood";
import { liAdapter } from "./li";
import { liDeepAdapter } from "./liDeep";
import { propertyAdapter } from "./property";
import { schoolsAdapter } from "./schools";
import { taxAdapter } from "./tax";
import type { SectionAdapter, SectionContext, SectionDataMap, SectionId } from "./types";
import { zoningAdapter } from "./zoning";

/** Every adapter under its id, so `getSection(id)` knows the data type of the section it returns. */
const BY_ID: { [K in SectionId]: SectionAdapter<SectionDataMap[K]> } = {
  property: propertyAdapter,
  zoning: zoningAdapter,
  licenses_inspections: liAdapter,
  deeds: deedsAdapter,
  assessment_history: assessmentHistoryAdapter,
  tax: taxAdapter,
  flood: floodAdapter,
  schools: schoolsAdapter,
  li_deep: liDeepAdapter,
};

export const SECTIONS: readonly SectionAdapter[] = [
  propertyAdapter,
  zoningAdapter,
  liAdapter,
  deedsAdapter,
  assessmentHistoryAdapter,
  taxAdapter,
  floodAdapter,
  schoolsAdapter,
  liDeepAdapter,
];

/** The four atlas sections every dossier reads for free, in sheet order. */
export const FREE_SECTION_IDS: readonly SectionId[] = ["property", "zoning", "licenses_inspections", "deeds"];

/** The Agent sections of the standard tier (C1). */
export const STANDARD_AGENT_SECTION_IDS: readonly SectionId[] = ["assessment_history", "tax", "schools", "flood"];

/** The deep tier's one extra Agent section. */
export const DEEP_SECTION_ID: SectionId = "li_deep";

/** The adapter for a known id, typed with the data its section holds. */
export function getSection<K extends SectionId>(id: K): SectionAdapter<SectionDataMap[K]>;
/** The adapter for any string, or undefined when it is not a section id. */
export function getSection(id: string): SectionAdapter | undefined;
export function getSection(id: string): SectionAdapter | undefined {
  return Object.hasOwn(BY_ID, id) ? BY_ID[id as SectionId] : undefined;
}

/** The link a person uses by hand: the adapter's `manualUrl`, else its `url` (C3). */
export function manualUrlFor(section: SectionAdapter, ctx: SectionContext): string {
  return section.manualUrl?.(ctx) ?? section.url(ctx);
}
