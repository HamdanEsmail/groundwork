import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isAdmin } from "../src/auth";
import { callWorker } from "./helpers/app";

const ping = (headers?: Record<string, string>) => callWorker("/api/admin/ping", { method: "POST", headers });

describe("admin auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await ping();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "admin_required" });
  });

  it("rejects a wrong token", async () => {
    const res = await ping({ Authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "admin_required" });
  });

  it("rejects a token that is only a prefix or an extension of the real one", async () => {
    expect((await ping({ Authorization: "Bearer test-admi" })).status).toBe(401);
    expect((await ping({ Authorization: "Bearer test-admin-extra" })).status).toBe(401);
    expect((await ping({ Authorization: "Bearer " })).status).toBe(401);
  });

  it("rejects the right token without the Bearer scheme", async () => {
    expect((await ping({ Authorization: "test-admin" })).status).toBe(401);
    expect((await ping({ Authorization: "Basic test-admin" })).status).toBe(401);
  });

  it("accepts the right token", async () => {
    const res = await ping({ Authorization: "Bearer test-admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("is false for every request when ADMIN_TOKEN is empty", async () => {
    // A throwaway app so the binding can be set to "" without touching the real one.
    const probe = new Hono<{ Bindings: { ADMIN_TOKEN: string } }>();
    probe.get("/", (c) => c.json({ admin: isAdmin(c as never) }));
    const ask = (token: string) =>
      probe.request("/", { headers: { Authorization: `Bearer ${token}` } }, { ADMIN_TOKEN: "" });
    expect(await (await ask("")).json()).toEqual({ admin: false });
    expect(await (await ask("anything")).json()).toEqual({ admin: false });
  });
});
