import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// This file runs in Node; the environment is typed here without @types/node.
const { process } = globalThis as unknown as {
  process: {
    env: Record<string, string | undefined>;
  };
};

// Live tests use a shell-provided key only when enabled; check always disables them.
function liveKey(): string | undefined {
  if (process.env.npm_lifecycle_event === "check" || process.env.GROUNDWORK_LIVE !== "1") return undefined;
  return process.env.TINYFISH_API_KEY || undefined;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const live = liveKey();
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Fixed test values. They win over anything in .dev.vars, so unit
            // tests never see the real TinyFish key.
            TINYFISH_API_KEY: "test-tinyfish-key",
            ADMIN_TOKEN: "test-admin",
            WEBHOOK_SECRET: "test-secret",
            PUBLIC_BASE_URL: "https://groundwork.test",
            TEST_MIGRATIONS: await readD1Migrations("./migrations"),
            ...(live ? { LIVE_TINYFISH_API_KEY: live } : {}),
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
