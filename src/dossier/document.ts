// Serializes dossiers and sections into the public report document.
import { AGENT_SECTION_MAX_USD } from "../core/limits";
import type { Dossier, StoredSection } from "../db/types";
import { DEEP_SECTION_ID, getSection, manualUrlFor, SECTIONS, STANDARD_AGENT_SECTION_IDS } from "../sections/index";
import { gapReason, NOTHING_FOUND_TEXT } from "./reasons";

const COST_PRECISION = 1000;

/** Returns the public report with nine ordered sources; missing rows remain pending while a resolved build runs. */
export function toDossierDocument(dossier: Dossier, rows: StoredSection[], baseUrl: string, extras: { watch?: unknown } = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const ctx = { address: dossier.address_resolved?.split(",")[0] ?? "", opa: dossier.opa_account ?? "" };
  const resolved = dossier.outcome === "resolved";
  const sections = Object.fromEntries(SECTIONS.map((adapter) => {
    const row = rows.find((r) => r.section_id === adapter.id);
    const status = row?.status ?? (resolved ? "pending" : "unavailable");
    const sourceUrl = row?.source_url ?? (resolved ? adapter.url(ctx) : null);
    const section = {
      status, label: adapter.label, source: adapter.agency, source_url: sourceUrl,
      checked_at: row?.checked_at ?? null, method: row?.method ?? adapter.method,
      evidence_url: row?.evidence_key ? `${base}/${row.evidence_key}` : null, data: row?.data ?? null,
      ...(status === "error" || status === "unavailable" ? { reason: row?.error ?? (resolved ? null : "address_not_resolved"),
        // The same sentence the report page prints; `reason` stays the stored code for programs.
        reason_text: resolved ? gapReason(row?.error) : "The address was not resolved, so nothing was read.",
        manual_url: resolved ? manualUrlFor(adapter, ctx) : null } : {}),
      // A sheet that was searched and held nothing says so, with the page to check it by hand.
      ...(status === "empty" ? { reason_text: NOTHING_FOUND_TEXT, manual_url: resolved ? manualUrlFor(adapter, ctx) : null } : {}),
      ...(status === "skipped" ? { manual_url: resolved ? manualUrlFor(adapter, ctx) : null,
        upgrade_cost_usd: AGENT_SECTION_MAX_USD } : {}),
      ...(adapter.id === "licenses_inspections" ? { depth: row?.depth ?? "recent", rows_returned: row?.rows_returned ?? null,
        truncated: row?.depth === "extended" ? true : row?.depth === "full" ? false : null } : {}),
    };
    return [adapter.id, section];
  }));
  const sources = SECTIONS.map((a) => {
    const s = sections[a.id]!;
    return { id: a.id, agency: a.agency, label: a.label, url: s.source_url, checked_at: s.checked_at, status: s.status, method: s.method };
  });
  // Each tier offers only the next set of sections, so deep has no further upgrade.
  const next = dossier.tier === "free" ? STANDARD_AGENT_SECTION_IDS : dossier.tier === "standard" ? [DEEP_SECTION_ID] : [];
  const next_tier = resolved && next.length ? { tier: dossier.tier === "free" ? "standard" : "deep",
    adds: next.map((id) => getSection(id).label),
    cost_usd: Math.round(next.length * AGENT_SECTION_MAX_USD * COST_PRECISION) / COST_PRECISION,
  } : null;
  return {
    dossier_id: dossier.id, address: { input: dossier.address_input, resolved: dossier.address_resolved,
      opa_account: dossier.opa_account, resolution: dossier.resolution,
      ...(dossier.resolution === "fuzzy" ? { resolved_to: dossier.address_resolved } : {}), units: dossier.units },
    status: dossier.status, outcome: dossier.outcome, has_errors: rows.some((r) => r.status === "error"),
    // The sheets that were asked for and not read, in report order: "complete" means finished, not gapless.
    gaps: resolved ? SECTIONS.map((a) => a.id).filter((id) => ["error", "unavailable"].includes(sections[id]!.status)) : [],
    // The sheets whose source was searched and held nothing. They are not counted as read.
    nothing_found: resolved ? SECTIONS.map((a) => a.id).filter((id) => sections[id]!.status === "empty") : [],
    tier: dossier.tier,
    created_at: dossier.created_at, completed_at: dossier.completed_at, spend_usd: dossier.spend_usd,
    cached: dossier.cached_from !== null, cached_from: dossier.cached_from,
    sections, sources, next_tier, watch: extras.watch ?? null,
    ...(dossier.outcome !== "resolved" ? { resolution_detail: dossier.resolution_detail } : {}),
    report_url: `${base}/d/${dossier.id}`, json_url: `${base}/api/dossiers/${dossier.id}`,
  };
}

export type DossierDocument = ReturnType<typeof toDossierDocument>;
