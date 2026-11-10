// Builds dossiers from address resolution, free sections, cached results, and tiered reads.
import { AtlasUnavailableError, resolveAddress, type ResolveInput, type ResolveResult } from "../address/resolve";
import { AGENT_SECTION_MAX_USD, CACHE_HOURS, FLOOD_RETRY_DAYS, PUBLIC_DOSSIER_TTL_DAYS, PUBLIC_DOSSIERS_PER_IP_PER_DAY,
  SPEND_PAUSE_USD } from "../core/limits";
import { PRICES, totalSpend } from "../core/spend";
import { copySections, findCachedDossier, getDossier, insertDossier, updateDossier } from "../db/dossiers";
import { claimPublicUse, releasePublicUse } from "../db/publicUse";
import { getSections, upsertSection } from "../db/sections";
import type { Tier } from "../db/types";
import type { Env } from "../env";
import { DEEP_SECTION_ID, FREE_SECTION_IDS, getSection, STANDARD_AGENT_SECTION_IDS } from "../sections/index";
import type { LicensesInspectionsData, SectionContext, SectionId } from "../sections/types";
import { MIN_EVIDENCE_BYTES } from "../tinyfish/browser";
import { TinyFishError } from "../tinyfish/client";
import { fetchAtlas, type AtlasTab } from "../tinyfish/fetch";
import { buildDeps } from "./deps";
import { dossierStatus } from "./status";

export interface CreateInput extends ResolveInput { tier?: Tier; fresh?: boolean; callback_url?: string; curated?: boolean }
export interface Caller { admin: boolean; ipHash: string }
export class DossierError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error)); }
}
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const COST_PRECISION = 1000;
const rounded = (n: number) => Math.round(n * COST_PRECISION) / COST_PRECISION;
const agents = [...STANDARD_AGENT_SECTION_IDS, DEEP_SECTION_ID];
/** Section errors that leave a TinyFish run unread: the run may have finished and its result still be there. */
const UNREAD_RUN_ERRORS = new Set(["agent_poll_failed", "agent_timeout"]);
const base = (env: Env) => env.PUBLIC_BASE_URL.replace(/\/$/, "");
const url = (env: Env, id: string) => `${base(env)}/d/${id}`;

function liEmpty(data: LicensesInspectionsData): boolean {
  return !data.buildings.length && !(data.buildings_count && data.buildings_count > 0) &&
    [data.certifications, data.permits, data.zoning_documents, data.inspections, data.violations, data.appeals,
      data.business_licenses].every((x) => !(x.count && x.count > 0) && x.recent.length === 0);
}

/** Reads and stores the free sections, returning when all are written. Property text is reused to avoid a second read. */
export async function buildFreeSections(env: Env, id: string, ctx: SectionContext, propertyText: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const tabs: Record<string, AtlasTab> = { zoning: "zoning", licenses_inspections: "li", deeds: "deeds" };
  await Promise.all(FREE_SECTION_IDS.map(async (sid) => {
    const adapter = getSection(sid);
    const source = adapter.url(ctx);
    const read = sid === "property" ? { ok: true as const, text: propertyText, url: source } : await fetchAtlas(env,
      ctx.address, tabs[sid]!, opts);
    const data = read.ok ? adapter.parse?.(read.text) ?? null : null;
    const error = read.ok ? (data === null ? "unrecognized_page" : null) : read.error;
    const status = error ? "error" : sid === "licenses_inspections" && liEmpty(data as LicensesInspectionsData) ? "empty" : "ok";
    await upsertSection(env.DB, id, sid, { status, method: "fetch", source_url: source, checked_at: new Date().toISOString(),
      data, error, spend_usd: 0 });
  }));
  const dossier = await getDossier(env.DB, id);
  // Multiple active parcels identify a parent unless resolution already identified condominium units.
  if (dossier?.resolution !== "parent") {
    const rows = await getSections(env.DB, id);
    const counts = rows.filter((r) => r.section_id === "zoning"
      || r.section_id === "deeds").map((r) => (r.data as { active_parcels?: number } | null)?.active_parcels ?? 0);
    const count = Math.max(0, ...counts);
    if (count > 1) await updateDossier(env.DB, id, { resolution: "parent", units: { count, list: null, list_url: null,
      kind: "active_parcels" } });
  }
}

/** One free-section screenshot: same conditions, R2 key, billing and spend bookkeeping as the former sequential loop. */
export async function screenshotSection(env: Env, dossierId: string, sectionId: string): Promise<void> {
  const section = (await getSections(env.DB, dossierId)).find((row) => row.section_id === sectionId);
  if (!section || section.method !== "fetch" || !section.source_url
    || (section.status !== "ok" && section.status !== "empty") || section.evidence_key) return;
  // Stop starting screenshots at the spend pause, checking again before every sequential session.
  if (await totalSpend(env.DB) >= SPEND_PAUSE_USD) { console.log("screenshot skipped: spend paused"); return; }
  let billed = false;
  try {
    const result = await buildDeps.screenshotFullPage(env, section.source_url);
    billed = true;
    // An unsettled page or a tiny image is not evidence; the session is still billed.
    if (result.settled && result.bytes.byteLength >= MIN_EVIDENCE_BYTES) {
      const key = `evidence/${dossierId}/${section.section_id}.jpg`;
      await env.STORE.put(key, result.bytes, { httpMetadata: { contentType: "image/jpeg" } });
      await upsertSection(env.DB, dossierId, section.section_id as SectionId, { evidence_key: key });
    }
  } catch (err) {
    // A TinyFish refusal is not billed; other screenshot failures are treated as failures after session start.
    billed = !(err instanceof TinyFishError);
    console.error("screenshot failed", err instanceof Error ? err.name : typeof err);
  }
  if (billed) {
    await upsertSection(env.DB, dossierId, section.section_id as SectionId, { spend_usd: PRICES.screenshot });
    const current = await getDossier(env.DB, dossierId);
    if (current) await updateDossier(env.DB, dossierId, { spend_usd: rounded(current.spend_usd + PRICES.screenshot) });
  }
}

/** Starts selected sections and returns their count; a recent flood result is reused to avoid another probe. */
export async function startAgentSections(env: Env, dossierId: string, sectionIds: readonly SectionId[]): Promise<number> {
  const selected = [...sectionIds];
  const dossier = await getDossier(env.DB, dossierId);
  if (selected.includes("flood") && dossier?.opa_account) {
    const cutoff = new Date(Date.now() - FLOOD_RETRY_DAYS * MILLISECONDS_PER_DAY).toISOString();
    const prior = await env.DB.prepare(`SELECT s.dossier_id FROM sections s JOIN dossiers d ON d.id = s.dossier_id
      WHERE d.opa_account = ? AND d.id != ? AND s.section_id = 'flood' AND s.status IN ('ok', 'unavailable')
      AND s.checked_at >= ? ORDER BY s.checked_at DESC LIMIT 1`).bind(dossier.opa_account, dossierId, cutoff)
      .first<{ dossier_id: string }>();
    if (prior) {
      const flood = (await getSections(env.DB, prior.dossier_id)).find((s) => s.section_id === "flood");
      if (flood) {
        await upsertSection(env.DB, dossierId, "flood", { status: flood.status, method: flood.method,
          source_url: flood.source_url, checked_at: flood.checked_at, evidence_key: flood.evidence_key,
          data: flood.data, error: flood.error, spend_usd: 0 });
        selected.splice(selected.indexOf("flood"), 1);
      }
    }
  }
  const existing = await getSections(env.DB, dossierId);
  const toStart: SectionId[] = [];
  for (const sid of selected) {
    const row = existing.find((item) => item.section_id === sid);
    // An ok row, or a pending row that already has a TinyFish run, must not be reset.
    if (row?.status === "ok" || (row?.status === "pending" && row.run_id)) continue;
    // A run that was paid for and never read is read again, not bought a second time.
    if (row?.status === "error" && row.run_id && UNREAD_RUN_ERRORS.has(row.error ?? "")) {
      await upsertSection(env.DB, dossierId, sid, { status: "pending", error: null });
      toStart.push(sid);
      continue;
    }
    const ctx = { address: dossier?.address_resolved?.split(",")[0] ?? "", opa: dossier?.opa_account ?? "" };
    await upsertSection(env.DB, dossierId, sid, { status: "pending", method: "agent", source_url: getSection(sid).url(ctx),
      error: null, run_id: null, data: null, checked_at: null, evidence_key: null, spend_usd: 0 });
    toStart.push(sid);
  }
  if (!toStart.length) return 0;
  // One Workflow instance for each section. On the free plan an invocation may make 50 requests to
  // other hosts; one section's start, polls and screenshot fit inside that, five sections do not.
  // The Agent slot still lets only one of them run at a time.
  const ids = toStart.map((sid) => `${dossierId}-${sid}-${crypto.randomUUID().slice(0, 8)}`);
  await updateDossier(env.DB, dossierId, { workflow_id: ids[0]!, workflow_started_at: new Date().toISOString(),
    status: "partial", completed_at: null });
  for (let i = 0; i < toStart.length; i++) {
    await env.DOSSIER_WORKFLOW.create({ id: ids[i]!, params: { dossierId, sections: [toStart[i]!] } });
  }
  return toStart.length;
}

/** Stores tier eligibility and returns the number started, leaving excluded sections skipped for upgrade. */
export async function applyTier(env: Env, id: string, tier: Tier, ctx: SectionContext): Promise<number> {
  for (const sid of agents) await upsertSection(env.DB, id, sid, { status: "skipped", method: "agent",
    source_url: getSection(sid).url(ctx), data: null, error: null });
  // Free starts none, standard starts four, and deep starts all five sections.
  const selected = tier === "free" ? [] : tier === "standard" ? [...STANDARD_AGENT_SECTION_IDS] : agents;
  if (selected.length) {
    try { return await startAgentSections(env, id, selected); }
    catch (err) {
      console.error("workflow start failed", err instanceof Error ? err.name : typeof err);
      const rows = await getSections(env.DB, id);
      for (const sid of selected) {
        if (rows.some((row) => row.section_id === sid && row.status === "pending")) {
          await upsertSection(env.DB, id, sid, { status: "error", error: "workflow_start_failed" });
        }
      }
      await updateDossier(env.DB, id, { workflow_id: null, workflow_started_at: null });
      return 0;
    }
  }
  return selected.length;
}

/** Resolves and builds or reuses a dossier, returning its response fields; public creates consume a daily slot. */
export async function createDossier(env: Env, input: CreateInput, who: Caller,
  opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  const tier: Tier = who.admin ? input.tier ?? "standard" : "free";
  const now = new Date();
  // Public creates count even on cache hits and no-match answers, so claim before resolving.
  if (!who.admin && !(await claimPublicUse(env.DB, who.ipHash, "dossiers", PUBLIC_DOSSIERS_PER_IP_PER_DAY, { now }))) {
    throw new DossierError(429, { error: "rate_limited", limit: PUBLIC_DOSSIERS_PER_IP_PER_DAY });
  }

  async function resolveRequest() {
    try {
      return await resolveAddress(env, input, opts);
    } catch (err) {
      // A failed resolution request produces no dossier, so return the public slot.
      if (!who.admin) await releasePublicUse(env.DB, who.ipHash, "dossiers", { now });
      if (err instanceof AtlasUnavailableError) {
        throw new DossierError(502, { error: "atlas_unavailable", code: err.code, manual_url: "https://atlas.phila.gov/" });
      }
      throw err;
    }
  }

  const resolution = await resolveRequest();
  const added_by = who.admin ? input.curated ? "curated" as const : "admin" as const : "public" as const;
  const common = {
    address_input: input.address ?? input.opa_account ?? null,
    unit: input.unit ?? null,
    added_by,
    ip_hash: who.admin ? null : who.ipHash,
    expires_at: who.admin ? null : new Date(now.getTime() + PUBLIC_DOSSIER_TTL_DAYS * MILLISECONDS_PER_DAY).toISOString(),
    created_at: now.toISOString(),
    callback_url: who.admin ? input.callback_url ?? null : null,
  };

  async function unresolvedAnswer(result: Exclude<ResolveResult, { outcome: "resolved" }>) {
    const noHouseNumber = result.outcome === "no_match" && !!input.address && !/\d/.test(input.address);
    const detail = result.outcome === "no_match"
      ? { variants_tried: result.variants_tried, manual_url: result.manual_url,
          how_to_resolve: noHouseNumber
            ? "Include the house number, for example 1234 Market St, or use the 9-digit OPA account."
            : "Check the address or OPA account and try again." }
      : { candidates: result.candidates, manual_url: "https://atlas.phila.gov/",
          how_to_resolve: "Choose the matching address and try again." };
    const dossierId = await insertDossier(env.DB, {
      ...common, tier, status: "failed", outcome: result.outcome, resolution_detail: detail,
    });
    return {
      dossierId, status: "failed" as const, outcome: result.outcome, detail,
      reportUrl: url(env, dossierId), cached: false, tier, estimatedCostUsd: 0,
    };
  }
  if (resolution.outcome !== "resolved") return unresolvedAnswer(resolution);

  async function cachedAnswer(hit: NonNullable<Awaited<ReturnType<typeof findCachedDossier>>>) {
    let dossierId = hit.id;
    // A copy stays partial until its sections are copied, preventing an empty complete dossier.
    if (hit.status === "complete") {
      dossierId = await insertDossier(env.DB, {
        ...common, tier: hit.tier, status: "partial", outcome: "resolved",
        address_resolved: hit.address_resolved, opa_account: hit.opa_account, resolution: hit.resolution,
        units: hit.units, resolution_detail: hit.resolution_detail, cached_from: hit.id,
      });
      await copySections(env.DB, hit.id, dossierId);
      await updateDossier(env.DB, dossierId, { status: hit.status, completed_at: hit.completed_at });
    }
    return {
      dossierId, status: hit.status, outcome: "resolved" as const, cached: true, tier: hit.tier,
      estimatedCostUsd: 0, reportUrl: url(env, dossierId),
    };
  }
  // An in-progress hit returns its existing id; a completed hit gets a copy for this requester.
  const hit = input.fresh ? null : await findCachedDossier(env.DB, resolution.opa_account, CACHE_HOURS, { minTier: tier });
  if (hit) return cachedAnswer(hit);

  async function freshBuild(result: Extract<ResolveResult, { outcome: "resolved" }>) {
    const city = /^# [^\n]+\r?\n\s*\r?\n([^\n]+)/m.exec(result.property_text)?.[1]?.trim();
    const address = city?.startsWith("PHILADELPHIA,") ? `${result.address_resolved}, ${city}` : result.address_resolved;
    const units = result.units ? { ...result.units, kind: "condominium_units" as const } : null;
    const id = await insertDossier(env.DB, {
      ...common, tier, status: "partial", outcome: "resolved", address_resolved: address,
      opa_account: result.opa_account, resolution: result.resolution, units,
    });
    const ctx = { address: result.address_resolved, opa: result.opa_account };
    await buildFreeSections(env, id, ctx, result.property_text, opts);
    const count = await applyTier(env, id, tier, ctx);
    const state = dossierStatus(tier, await getSections(env.DB, id));
    await updateDossier(env.DB, id, {
      status: state.status, completed_at: state.status === "partial" ? null : new Date().toISOString(),
    });
    try {
      await env.DOSSIER_WORKFLOW.create({
        id: `${id}-ev-${crypto.randomUUID().slice(0, 8)}`,
        params: { dossierId: id, sections: [], evidence: true },
      });
    } catch (err) {
      console.error("evidence workflow start failed", err instanceof Error ? err.name : typeof err);
    }
    return {
      dossierId: id, status: state.status, outcome: "resolved" as const, cached: false, tier,
      estimatedCostUsd: rounded(FREE_SECTION_IDS.length * PRICES.screenshot + count * AGENT_SECTION_MAX_USD),
      reportUrl: url(env, id),
    };
  }
  return freshBuild(resolution);
}
