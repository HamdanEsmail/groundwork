// Create monitors for a dossier. The JSON route and the form route both call this.
import { MAX_MONITORS, PUBLIC_WATCHES_PER_IP_PER_DAY, PUBLIC_WATCH_SLOTS, PUBLIC_WATCH_TTL_DAYS } from "../core/limits";
import { getDossier } from "../db/dossiers";
import { upsertParcelSection } from "../db/parcels";
import { claimPublicUse, releasePublicUse } from "../db/publicUse";
import { getSections } from "../db/sections";
import { listWatches, setWatchStatus } from "../db/watches";
import type { Env } from "../env";
import { liAdapter } from "../sections/li";
import { propertyAdapter } from "../sections/property";
import { isIncomplete } from "../tinyfish/fetch";
import { createMonitor, deleteMonitor } from "../tinyfish/monitor";

export type WatchCaller = { admin: boolean; ipHash: string | null };

export type WatchResult =
  | { ok: true; watch_id: string; monitors: readonly string[]; expires_at: string | null }
  | { ok: false; status: 400 | 404 | 409 | 429 | 502 | 503; error: string; detail?: string; limit?: number };

/** Starts the Monitor (or Monitors) for one resolved dossier. */
export async function watchDossier(
  env: Env,
  dossierId: string,
  who: WatchCaller,
  body: Record<string, unknown> = {},
): Promise<WatchResult> {
  const d = await getDossier(env.DB, dossierId);
  if (!d || d.outcome !== "resolved" || !d.opa_account || !d.address_resolved) return { ok: false, status: 404, error: "not_found" };
  if (!env.WEBHOOK_SECRET) return { ok: false, status: 503, error: "webhook_secret_missing" };
  if (body.callback_url !== undefined) {
    if (!who.admin) return { ok: false, status: 400, error: "invalid_input", detail: "callbacks need the admin token" };
    if (typeof body.callback_url !== "string") return { ok: false, status: 400, error: "invalid_input", detail: "Invalid watch request" };
    try {
      if (new URL(body.callback_url).protocol !== "https:") return { ok: false, status: 400, error: "invalid_input", detail: "Invalid watch request" };
    } catch {
      return { ok: false, status: 400, error: "invalid_input", detail: "Invalid watch request" };
    }
  }
  // A public dossier's callback is never copied onto a watch.
  const callbackUrl = who.admin
    ? typeof body.callback_url === "string"
      ? body.callback_url
      : d.added_by === "public"
        ? null
        : d.callback_url
    : null;
  const owner = who.admin ? (d.added_by === "curated" ? "curated" : "admin") : "public";
  const kinds = who.admin ? (["li", "property"] as const) : (["li"] as const);
  const existing = await listWatches(env.DB, { opa: d.opa_account, status: "active" });
  if (existing.length) return { ok: false, status: 409, error: "already_watched" };
  // One watch a day per visitor, so one visitor cannot hold every public slot.
  const now = new Date();
  const visitor = who.admin ? null : (who.ipHash ?? "unknown");
  if (visitor !== null && !(await claimPublicUse(env.DB, visitor, "watches", PUBLIC_WATCHES_PER_IP_PER_DAY, { now }))) {
    return { ok: false, status: 429, error: "rate_limited", limit: PUBLIC_WATCHES_PER_IP_PER_DAY };
  }
  const sections = await getSections(env.DB, d.id);
  const created: string[] = [];
  const expires = who.admin ? null : new Date(Date.now() + PUBLIC_WATCH_TTL_DAYS * 86400000).toISOString();
  for (const kind of kinds) {
    const id = crypto.randomUUID();
    // Reservations count toward both caps until creation succeeds or is rolled back.
    const reservation = await env.DB.prepare(
      `INSERT INTO watches (id,opa_account,kind,added_by,callback_url,expires_at,status,created_at,owner_hash)
      SELECT ?1,?2,?3,?4,?5,?6,'active',?7,?10 WHERE
      (SELECT count(*) FROM watches WHERE status='active') < ?8 AND
      (?4 != 'public' OR (SELECT count(*) FROM watches WHERE status='active' AND added_by='public') < ?9) AND
      NOT EXISTS (SELECT 1 FROM watches WHERE status='active' AND opa_account=?2 AND kind=?3)`,
    )
      .bind(id, d.opa_account, kind, owner, callbackUrl, expires, new Date().toISOString(), MAX_MONITORS, PUBLIC_WATCH_SLOTS, who.ipHash)
      .run();
    if (!reservation.meta.changes) {
      for (const wid of created) {
        const w = (await listWatches(env.DB, { opa: d.opa_account, status: "active" })).find((x) => x.id === wid);
        if (w?.monitor_id) {
          try {
            await deleteMonitor(env, w.monitor_id);
            await setWatchStatus(env.DB, w.id, "removed");
          } catch {
            /* Keep the slot until deletion succeeds. */
          }
        }
      }
      if (visitor !== null) await releasePublicUse(env.DB, visitor, "watches", { now });
      return { ok: false, status: 409, error: "watch_capacity" };
    }
    try {
      const adapter = kind === "li" ? liAdapter : propertyAdapter;
      const ctx = { address: d.address_resolved, opa: d.opa_account };
      const hash = [...d.opa_account].reduce((a, ch) => a + ch.charCodeAt(0), 0) + (kind === "li" ? 0 : 7);
      const minute = hash % 60,
        hour = hash % 12;
      const monitor = await createMonitor(env, {
        url: adapter.url(ctx),
        name: `${kind} ${d.opa_account}`,
        scheduleCron: `${minute} ${hour},${hour + 12} * * *`,
        purpose: adapter.purpose!,
        webhookUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/hooks/monitor/${encodeURIComponent(env.WEBHOOK_SECRET)}`,
        onCreated: async (monitorId) => {
          await env.DB.prepare("UPDATE watches SET monitor_id=? WHERE id=?").bind(monitorId, id).run();
        },
      });
      await env.DB.prepare("UPDATE watches SET monitor_id=? WHERE id=?").bind(monitor.monitorId, id).run();
      created.push(id);
      if (kind === "li") {
        const baseline = !isIncomplete(monitor.baselineText) ? liAdapter.parse!(monitor.baselineText) : null;
        const fallback = sections.find((s) => s.section_id === "licenses_inspections")?.data;
        if (baseline) await upsertParcelSection(env.DB, d.opa_account, "licenses_inspections", baseline, d.address_resolved);
        else if (fallback)
          await upsertParcelSection(
            env.DB,
            d.opa_account,
            "licenses_inspections",
            fallback as NonNullable<ReturnType<NonNullable<typeof liAdapter.parse>>>,
            d.address_resolved,
          );
      } else {
        const baseline = !isIncomplete(monitor.baselineText) ? propertyAdapter.parse!(monitor.baselineText) : null;
        const fallback = sections.find((s) => s.section_id === "property")?.data;
        if (baseline) await upsertParcelSection(env.DB, d.opa_account, "property", baseline, d.address_resolved);
        else if (fallback)
          await upsertParcelSection(
            env.DB,
            d.opa_account,
            "property",
            fallback as NonNullable<ReturnType<NonNullable<typeof propertyAdapter.parse>>>,
            d.address_resolved,
          );
      }
    } catch {
      const failedWatch = (await listWatches(env.DB, { opa: d.opa_account, status: "active" })).find((w) => w.id === id);
      if (failedWatch?.monitor_id) {
        try {
          await deleteMonitor(env, failedWatch.monitor_id);
          await setWatchStatus(env.DB, id, "removed");
        } catch {
          /* Keep the slot until deletion succeeds. */
        }
      } else await env.DB.prepare("DELETE FROM watches WHERE id=? AND monitor_id IS NULL").bind(id).run();
      for (const wid of created) {
        const w = (await listWatches(env.DB, { opa: d.opa_account, status: "active" })).find((x) => x.id === wid);
        if (w?.monitor_id) {
          try {
            await deleteMonitor(env, w.monitor_id);
            await setWatchStatus(env.DB, w.id, "removed");
          } catch {
            /* Keep the slot until deletion succeeds. */
          }
        }
      }
      if (visitor !== null) await releasePublicUse(env.DB, visitor, "watches", { now });
      return { ok: false, status: 502, error: "monitor_create_failed" };
    }
  }
  return { ok: true, watch_id: created[0]!, monitors: kinds, expires_at: expires };
}
