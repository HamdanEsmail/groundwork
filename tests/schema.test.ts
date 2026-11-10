import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const run = (sql: string) => env.DB.prepare(sql).run();

async function names(type: "table" | "index"): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
  )
    .bind(type)
    .all<{ name: string }>();
  return results.map((r) => r.name).sort();
}

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("schema", () => {
  it("creates the tables and the indexes", async () => {
    expect(await names("table")).toEqual(
      ["agent_inflight", "dossiers", "events", "monitor_processing", "parcels", "pending_evidence_deletions", "public_use", "sections", "spend", "watches"],
    );
    expect(await names("index")).toEqual([
      "idx_dossiers_opa_created",
      "idx_events_opa_at",
      "idx_monitor_check_run",
      "idx_watches_monitor",
      "idx_watches_opa",
    ]);
  });

  it("has the spec columns plus the additions made while building", async () => {
    expect(await columns("dossiers")).toEqual([
      "id", "address_input", "address_resolved", "opa_account", "unit", "resolution", "outcome", "tier", "status",
      "cached_from", "ip_hash", "added_by", "created_at", "completed_at", "spend_usd", "expires_at",
      "workflow_id", "workflow_started_at", "callback_url", "units", "resolution_detail",
    ]);
    expect(await columns("sections")).toEqual([
      "dossier_id", "section_id", "status", "method", "source_url", "checked_at", "evidence_key", "data", "raw_key",
      "run_id", "error", "spend_usd", "rows_returned", "depth",
    ]);
    expect(await columns("parcels")).toEqual(["opa_account", "address_resolved", "last_section_data", "updated_at", "li_checked_at"]);
    expect(await columns("watches")).toEqual([
      "id", "opa_account", "kind", "monitor_id", "added_by", "callback_url", "expires_at", "status", "created_at", "owner_hash", "last_applied_at",
    ]);
    expect(await columns("events")).toEqual([
      "id", "opa_account", "kind", "summary", "rows", "before", "after", "source_url", "monitor_run_id", "at", "notified_at",
    ]);
    expect(await columns("spend")).toEqual(["id", "kind", "amount_usd", "ref", "at"]);
    expect(await columns("public_use")).toEqual(["ip_hash", "day", "dossiers", "watches", "upgrades"]);
    expect(await columns("agent_inflight")).toEqual(["id", "run_id", "started_at"]);
    expect(await columns("monitor_processing")).toEqual(["monitor_id", "holder", "started_at"]);
    expect(await columns("pending_evidence_deletions")).toEqual(["evidence_key"]);
  });

  it("applies the defaults later tasks rely on", async () => {
    await run("INSERT INTO public_use (ip_hash, day) VALUES ('defaults-h', '2026-11-03')");
    expect(
      await env.DB.prepare("SELECT dossiers, watches, upgrades FROM public_use WHERE ip_hash = 'defaults-h'").first(),
    ).toEqual({ dossiers: 0, watches: 0, upgrades: 0 });
  });

  it("accepts the fixed enum values, and null while a row is pending", async () => {
    await run("INSERT INTO dossiers (id) VALUES ('ok0')");
    await run(
      "INSERT INTO dossiers (id, resolution, outcome, tier, status, added_by) VALUES ('ok1', 'parent', 'resolved', 'deep', 'complete', 'curated')",
    );
    await run(
      "INSERT INTO dossiers (id, resolution, outcome, tier, status, added_by) VALUES ('ok2', 'fuzzy', 'ambiguous', 'standard', 'partial', 'admin')",
    );
    // A no_match build still gets a row: failed, with nothing resolved.
    await run(
      "INSERT INTO dossiers (id, address_input, outcome, tier, status, added_by) VALUES ('ok3', '1 Nowhere St', 'no_match', 'free', 'failed', 'public')",
    );
    for (const status of ["ok", "empty", "unavailable", "pending", "error", "skipped"]) {
      await run(
        `INSERT INTO sections (dossier_id, section_id, status, method) VALUES ('ok1', 's-${status}', '${status}', 'agent')`,
      );
    }
    await run(
      "INSERT INTO sections (dossier_id, section_id, status, method, depth) VALUES ('ok1', 'licenses_inspections', 'ok', 'fetch', 'extended')",
    );
    await run("INSERT INTO sections (dossier_id, section_id) VALUES ('ok1', 'pending-row')");
    await run("INSERT INTO watches (id, kind, added_by) VALUES ('ok4', 'li', 'public')");
    await run("INSERT INTO watches (id, kind, added_by) VALUES ('ok5', 'property', 'curated')");
    for (const kind of [
      "new_permit", "new_violation", "violation_closed", "new_inspection", "new_appeal",
      "certification_expired", "assessment_change", "sale", "other",
    ]) {
      await run(`INSERT INTO events (id, kind) VALUES ('ev-${kind}', '${kind}')`);
    }
  });

  it("rejects values outside the fixed enums", async () => {
    await expect(run("INSERT INTO dossiers (id, resolution) VALUES ('bad1', 'close')")).rejects.toThrow();
    await expect(run("INSERT INTO dossiers (id, outcome) VALUES ('bad2', 'maybe')")).rejects.toThrow();
    await expect(run("INSERT INTO dossiers (id, tier) VALUES ('bad3', 'premium')")).rejects.toThrow();
    await expect(run("INSERT INTO dossiers (id, status) VALUES ('bad4', 'running')")).rejects.toThrow();
    await expect(run("INSERT INTO dossiers (id, added_by) VALUES ('bad5', 'anyone')")).rejects.toThrow();
    await expect(run("INSERT INTO sections (dossier_id, section_id, status) VALUES ('d', 'bad6', 'done')")).rejects.toThrow();
    await expect(run("INSERT INTO sections (dossier_id, section_id, method) VALUES ('d', 'bad7', 'browser')")).rejects.toThrow();
    await expect(run("INSERT INTO sections (dossier_id, section_id, depth) VALUES ('d', 'bad8', 'shallow')")).rejects.toThrow();
    await expect(run("INSERT INTO watches (id, kind) VALUES ('bad9', 'feed')")).rejects.toThrow();
    await expect(run("INSERT INTO watches (id, added_by) VALUES ('bad10', 'robot')")).rejects.toThrow();
    await expect(run("INSERT INTO events (id, kind) VALUES ('bad11', 'alert')")).rejects.toThrow();
  });

  it("keys sections by (dossier_id, section_id) and public_use by (ip_hash, day)", async () => {
    await run("INSERT INTO sections (dossier_id, section_id) VALUES ('d1', 'property')");
    await run("INSERT INTO sections (dossier_id, section_id) VALUES ('d1', 'zoning')");
    await run("INSERT INTO sections (dossier_id, section_id) VALUES ('d2', 'property')");
    await expect(run("INSERT INTO sections (dossier_id, section_id) VALUES ('d1', 'zoning')")).rejects.toThrow();
    await run("INSERT INTO public_use (ip_hash, day) VALUES ('h', '2026-11-03')");
    await run("INSERT INTO public_use (ip_hash, day) VALUES ('h', '2026-11-04')");
    await run("INSERT INTO public_use (ip_hash, day) VALUES ('other', '2026-11-03')");
    await expect(run("INSERT INTO public_use (ip_hash, day) VALUES ('h', '2026-11-03')")).rejects.toThrow();
  });

  it("keys parcels by opa_account", async () => {
    await run("INSERT INTO parcels (opa_account) VALUES ('883309050')");
    await expect(run("INSERT INTO parcels (opa_account) VALUES ('883309050')")).rejects.toThrow();
  });

  it("allows only one agent_inflight row, and only with id 1", async () => {
    await run("INSERT INTO agent_inflight (id, run_id, started_at) VALUES (1, 'run-1', '2026-11-03T12:00:00.000Z')");
    await expect(run("INSERT INTO agent_inflight (id, run_id) VALUES (1, 'run-2')")).rejects.toThrow();
    await expect(run("INSERT INTO agent_inflight (id, run_id) VALUES (2, 'run-2')")).rejects.toThrow();
    await run("DELETE FROM agent_inflight WHERE id = 1");
    await expect(run("INSERT INTO agent_inflight (id, run_id) VALUES (0, 'run-3')")).rejects.toThrow();
    await run("INSERT INTO agent_inflight (id, run_id) VALUES (1, 'run-3')");
  });
});
