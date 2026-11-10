import { readFile } from "node:fs/promises";
import { hasMonitorCapacity, parseDemoAddresses } from "./demo-addresses.mjs";
export { parseDemoAddresses } from "./demo-addresses.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || !args.includes("--base") || !args.includes("--token")) {
  console.error("Usage: node scripts/build-demos.mjs --base <url> --token <admin>");
  process.exit(1);
}
const baseArg = args[args.indexOf("--base") + 1];
const token = args[args.indexOf("--token") + 1];
try {
  if (!token || token.startsWith("--")) throw new Error();
  const base = new URL(baseArg);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error();
  const origin = base.origin;
  const addresses = parseDemoAddresses(await readFile(new URL("../docs/demo-addresses.md", import.meta.url), "utf8"));
  async function request(path, method = "GET", body) {
    const response = await fetch(origin + path, { method, redirect: "error", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Request failed: ${method} ${path.replace(/\/dossiers\/[^/]+/, "/dossiers/:id")} (HTTP ${response.status})`);
    return response.json();
  }
  const stats = await request("/api/stats");
  if (!hasMonitorCapacity(stats.watches, addresses.length)) throw new Error("Insufficient monitor capacity (watch count is a conservative upper bound)");
  for (const item of addresses) {
    const created = await request("/api/dossiers", "POST", { address: item.address, tier: "deep", curated: true });
    if (created.outcome !== "resolved" || typeof created.dossier_id !== "string" || !/^[a-zA-Z0-9-]+$/.test(created.dossier_id)) throw new Error("Dossier did not resolve");
    const path = `/api/dossiers/${encodeURIComponent(created.dossier_id)}`;
    const deadline = Date.now() + 45 * 60 * 1000;
    let dossier;
    do {
      dossier = await request(path);
      if (dossier.status === "failed") throw new Error("Dossier failed");
      if (dossier.status === "complete") break;
      if (dossier.status !== "partial") throw new Error("Unexpected dossier status");
      if (Date.now() >= deadline) throw new Error("Dossier polling timed out");
      await new Promise(resolve => setTimeout(resolve, 10000));
    } while (true);
    await request(path + "/watch", "POST");
    console.log(`${item.address}: ${origin}/d/${encodeURIComponent(created.dossier_id)}`.split(token).join("[redacted]"));
  }
  const finalStats = await request("/api/stats");
  console.log("/api/stats " + JSON.stringify(finalStats).split(token).join("[redacted]"));
} catch (error) {
  const message = error instanceof Error && /^(Request failed:|Insufficient monitor capacity|Dossier |Unexpected dossier status|Expected three|Demo address table|Invalid demo address)/.test(error.message) ? error.message : "Demo builder failed; check the arguments and service availability";
  console.error(message.split(token || "\0").join("[redacted]"));
  process.exitCode = 1;
}
