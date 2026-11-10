import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordSpend } from "../src/core/spend";
import { callWorker } from "./helpers/app";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dossiers"),
    env.DB.prepare("DELETE FROM sections"),
    env.DB.prepare("DELETE FROM watches"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM spend"),
  ]);
});

const stats = async () => (await callWorker("/api/stats")).json();

describe("GET /api/stats", () => {
  it("counts rows and groups sections by the statuses present", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO dossiers (id) VALUES ('d1'), ('d2')"),
      env.DB.prepare(
        "INSERT INTO sections (dossier_id, section_id, status) VALUES ('d1', 'property', 'ok'), ('d1', 'zoning', 'ok'), ('d1', 'tax', 'pending'), ('d2', 'property', 'error')",
      ),
      env.DB.prepare("INSERT INTO watches (id) VALUES ('w1')"),
      env.DB.prepare("INSERT INTO events (id) VALUES ('e1'), ('e2'), ('e3')"),
    ]);
    expect(await stats()).toEqual({
      events_by_kind: { unknown: 3 },
      spend_by_kind: { agent_step: 0, monitor_check: 0, screenshot: 0, fetch: 0, search: 0 },
      cost_per_dossier_usd: 0,
      dossiers: 2,
      sections: { ok: 2, pending: 1, error: 1 },
      watches: 1,
      events: 3,
      spend_usd: 0,
      public_paused: false,
    });
  });

  it("prints money as money: no floating-point dust in the public ledger", async () => {
    await env.DB.prepare("INSERT INTO dossiers (id) VALUES ('d1'), ('d2'), ('d3')").run();
    // 17 runs of 10 steps at $0.016 add up to 2.7199999999999998 in floating point.
    for (let i = 0; i < 17; i++) await recordSpend(env.DB, "agent_step", 0.16, `run-${i}`);
    const body = (await stats()) as { spend_by_kind: { agent_step: number }; spend_usd: number; cost_per_dossier_usd: number };
    expect(body.spend_by_kind.agent_step).toBe(2.72);
    expect(body.spend_usd).toBe(2.72);
    expect(body.cost_per_dossier_usd).toBe(0.9067);
  });

  it("pauses public Agent use at PUBLIC_AGENT_PAUSE_USD ($6), not at SPEND_PAUSE_USD ($8)", async () => {
    await recordSpend(env.DB, "agent_step", 5.99, "run-1");
    expect(await stats()).toMatchObject({ spend_usd: 5.99, public_paused: false });
    await recordSpend(env.DB, "agent_step", 0.01, "run-2");
    expect(await stats()).toMatchObject({ spend_usd: 6, public_paused: true });
  });
});
