// Derives dossier status from the requested section results.
import { DEEP_SECTION_ID, FREE_SECTION_IDS, STANDARD_AGENT_SECTION_IDS } from "../sections/index";
import type { SectionStatus } from "../sections/types";
import type { Tier } from "../db/types";

/** Returns status and error presence; only errors in every requested section make a terminal build fail. */
export function dossierStatus(tier: Tier,
  sections: { section_id: string; status: SectionStatus }[]): { status: "partial" | "complete" | "failed"; hasErrors: boolean } {
  const requested = [...FREE_SECTION_IDS, ...(tier === "free" ? [] : STANDARD_AGENT_SECTION_IDS),
    ...(tier === "deep" ? [DEEP_SECTION_ID] : [])];
  const hasErrors = sections.some((s) => s.status === "error");
  if (requested.some((id) => !sections.some((s) => s.section_id === id))
    || sections.some((s) => s.status === "pending")) return { status: "partial", hasErrors };
  const failed = requested.every((id) => sections.some((s) => s.section_id === id && s.status === "error"));
  return { status: failed ? "failed" : "complete", hasErrors };
}
