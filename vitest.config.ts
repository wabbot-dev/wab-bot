import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs tests/workers/*.test.ts inside workerd (via Miniflare): the real Worker entry, the real SQLite Durable Object.
// All binding values below are FAKE, test-only strings. No network is used: Meta and the wake URL are stubbed in-test.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      remoteBindings: false, // the [ai] binding stays local (never a Cloudflare login or network); tests stub env.AI themselves
      miniflare: {
        bindings: {
          LAUNCH_MODE: "live",
          WA_ACCESS_TOKEN: "test-access-token-0000001",
          WA_APP_SECRET: "test-app-secret-0000001",
          WA_VERIFY_TOKEN: "test-verify-token-0001",
          WA_PHONE_NUMBER_IDS: "1000000000001",
          WAKE_URL: "https://wake.example.test/hook",
          WAKE_KEY: "test-wake-key-00000001",
          WAKE_DEBOUNCE_MS: "0",
          // read receipts / typing are their own Meta call; the suite counts message sends only (tests/send-behaviour.test.ts covers them)
          READ_RECEIPTS: "0",
          TYPING_INDICATOR: "0",
          MCP_TOKEN: "test-mcp-token-0000001",
          ADMIN_TOKEN: "test-admin-token-00001",
          CRON_SECRET: "test-cron-secret-00001",
          ADMIN_MCP_TOKEN: "test-admin-mcp-token-0123456789abcdef",
          XAI_API_KEY: "test-xai-key-0000000001",
          CALLING_MODE: "test",
          CALL_ALLOWED_CALLERS: "15550000001",
          CALL_MAX_SECONDS: "30",
        },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    fileParallelism: false, // one workerd at a time: more reliable on small machines
  },
});
