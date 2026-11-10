import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { PRICES, bookAgentRunSpend, recordSpend, spendByKind, totalSpend } from "../src/core/spend";
import { callWorker } from "./helpers/app";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM spend").run();
});

describe("spend ledger", () => {
  it("prices match the spec", () => {
    expect(PRICES).toEqual({ agent_step: 0.016, monitor_check: 0.005, screenshot: 0.002, fetch: 0, search: 0 });
  });

  it("recordSpend appends one row and /api/stats sums it", async () => {
    await recordSpend(env.DB, "monitor_check", PRICES.monitor_check, "watch-1");
    const { results } = await env.DB.prepare("SELECT id, kind, amount_usd, ref, at FROM spend").all<{
      id: string;
      kind: string;
      amount_usd: number;
      ref: string;
      at: string;
    }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "monitor_check", amount_usd: 0.005, ref: "watch-1" });
    expect(results[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(results[0]!.at).toISOString()).toBe(results[0]!.at);

    const res = await callWorker("/api/stats");
    expect(await res.json()).toMatchObject({ spend_usd: 0.005 });
  });

  it("totalSpend is 0 on an empty ledger and sums every row", async () => {
    expect(await totalSpend(env.DB)).toBe(0);
    await recordSpend(env.DB, "agent_step", PRICES.agent_step, "check-1");
    await recordSpend(env.DB, "agent_step", PRICES.agent_step, "check-1");
    await recordSpend(env.DB, "screenshot", PRICES.screenshot, "check-1");
    expect(await totalSpend(env.DB)).toBeCloseTo(0.034, 10);
  });

  it("spendByKind returns every kind, zero for the ones with no rows", async () => {
    expect(await spendByKind(env.DB)).toEqual({ agent_step: 0, monitor_check: 0, screenshot: 0, fetch: 0, search: 0 });

    await recordSpend(env.DB, "agent_step", PRICES.agent_step, "check-1");
    await recordSpend(env.DB, "agent_step", PRICES.agent_step, "check-2");
    await recordSpend(env.DB, "monitor_check", PRICES.monitor_check, "watch-1");
    await recordSpend(env.DB, "fetch", PRICES.fetch, "check-3");

    const byKind = await spendByKind(env.DB);
    expect(Object.keys(byKind).sort()).toEqual(["agent_step", "fetch", "monitor_check", "screenshot", "search"]);
    expect(byKind.agent_step).toBeCloseTo(0.032, 10);
    expect(byKind.monitor_check).toBeCloseTo(0.005, 10);
    expect(byKind.fetch).toBe(0);
    expect(byKind.screenshot).toBe(0);
    expect(byKind.search).toBe(0);
  });

  it("books one Agent run per TinyFish id and replaces a ceiling with the true figure", async () => {
    await bookAgentRunSpend(env.DB, "run-1", 0.224);
    await bookAgentRunSpend(env.DB, "run-1", 0.032);
    await bookAgentRunSpend(env.DB, "run-1", 0.032);
    const { results } = await env.DB.prepare("SELECT amount_usd, ref FROM spend WHERE ref = 'run-1'").all<{
      amount_usd: number; ref: string;
    }>();
    expect(results).toEqual([{ amount_usd: 0.032, ref: "run-1" }]);
    expect(await totalSpend(env.DB)).toBeCloseTo(0.032, 10);
    await bookAgentRunSpend(env.DB, "run-1", 0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM spend WHERE ref = 'run-1'").first()).toEqual({ n: 0 });
  });
});
