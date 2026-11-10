// The public "read the rest" action. The JSON route and the form route both call this.
import { AGENT_SECTION_MAX_USD, PUBLIC_AGENT_PAUSE_USD, PUBLIC_UPGRADES_PER_IP_PER_DAY } from "../core/limits";
import { totalSpend } from "../core/spend";
import { getDossier, updateDossier } from "../db/dossiers";
import { claimPublicUse, releasePublicUse } from "../db/publicUse";
import { getSections, upsertSection } from "../db/sections";
import type { Env } from "../env";
import { STANDARD_AGENT_SECTION_IDS } from "../sections/index";
import { startAgentSections } from "./build";

const COST_PRECISION = 1000;

export type UpgradeCaller = { admin: boolean; ipHash: string };

export type UpgradeResult =
  | { ok: true; pending: string[]; estimatedCostUsd: number }
  | { ok: false; status: 404 | 409 | 429 | 503 | 502; error: string; reason?: string; limit?: number };

/** Starts the four standard Agent sheets on a free, complete dossier. */
export async function upgradeDossier(env: Env, id: string, who: UpgradeCaller): Promise<UpgradeResult> {
  const dossier = await getDossier(env.DB, id);
  if (!dossier || dossier.status === "failed") return { ok: false, status: 404, error: "not_found" };
  const sections = await getSections(env.DB, dossier.id);
  if (
    dossier.status !== "complete" ||
    dossier.tier !== "free" ||
    !STANDARD_AGENT_SECTION_IDS.every((sid) => sections.some((s) => s.section_id === sid && s.status === "skipped"))
  ) {
    return { ok: false, status: 409, error: "already_upgraded" };
  }
  if (!who.admin && (await totalSpend(env.DB)) >= PUBLIC_AGENT_PAUSE_USD) {
    return {
      ok: false,
      status: 503,
      error: "budget_paused",
      reason: "budget paused for public requests; the free core is complete",
    };
  }
  const now = new Date();
  if (!who.admin && !(await claimPublicUse(env.DB, who.ipHash, "upgrades", PUBLIC_UPGRADES_PER_IP_PER_DAY, { now }))) {
    return { ok: false, status: 429, error: "rate_limited", limit: PUBLIC_UPGRADES_PER_IP_PER_DAY };
  }
  let started = 0;
  try {
    await updateDossier(env.DB, dossier.id, { tier: "standard", status: "partial", completed_at: null });
    started = await startAgentSections(env, dossier.id, STANDARD_AGENT_SECTION_IDS);
  } catch (err) {
    console.error("workflow start failed", err instanceof Error ? err.name : typeof err);
    for (const sid of STANDARD_AGENT_SECTION_IDS) await upsertSection(env.DB, dossier.id, sid, { status: "skipped", error: null });
    await updateDossier(env.DB, dossier.id, {
      tier: dossier.tier,
      status: dossier.status,
      completed_at: dossier.completed_at,
      workflow_id: dossier.workflow_id,
      workflow_started_at: dossier.workflow_started_at,
    });
    if (!who.admin) await releasePublicUse(env.DB, who.ipHash, "upgrades", { now });
    return { ok: false, status: 502, error: "workflow_start_failed" };
  }
  const rows = await getSections(env.DB, dossier.id);
  const pending = STANDARD_AGENT_SECTION_IDS.filter((sid) => rows.some((row) => row.section_id === sid && row.status === "pending"));
  return {
    ok: true,
    pending,
    estimatedCostUsd: Math.round(started * AGENT_SECTION_MAX_USD * COST_PRECISION) / COST_PRECISION,
  };
}
