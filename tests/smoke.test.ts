import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("GET /api/stats returns zero counts and spend on an empty database", async () => {
    const res = await SELF.fetch("https://groundwork.test/api/stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events_by_kind: {},
      spend_by_kind: { agent_step: 0, monitor_check: 0, screenshot: 0, fetch: 0, search: 0 },
      cost_per_dossier_usd: 0,
      dossiers: 0,
      sections: {},
      watches: 0,
      events: 0,
      spend_usd: 0,
      public_paused: false,
    });
  });

  it("admin route rejects a missing token", async () => {
    const res = await SELF.fetch("https://groundwork.test/api/admin/ping", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("runs with the fixed test bindings, never the real TinyFish key", () => {
    expect(env.TINYFISH_API_KEY === "test-tinyfish-key").toBe(true);
    expect(env.ADMIN_TOKEN).toBe("test-admin");
    expect(env.WEBHOOK_SECRET).toBe("test-secret");
    expect(env.PUBLIC_BASE_URL).toBe("https://groundwork.test");
  });
});
