import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../lib/config";
import { mergeEnv, sources, validateSecrets } from "../lib/secrets";

describe("validateSecrets", () => {
  it("accepts known names with sane values", () => {
    const r = validateSecrets({ WA_APP_SECRET: "abcdef0123456789", ADMIN_TOKEN: "a".repeat(16), LAUNCH_MODE: "test", TEST_RECIPIENTS: "1786, 1555" }, false);
    assert.equal(r.ok, true);
  });
  it("rejects unknown names, short bearer tokens, whitespace in secrets, control chars, bad LAUNCH_MODE, non-strings", () => {
    for (const bad of [{ NOPE: "x" }, { MCP_TOKEN: "short" }, { WA_ACCESS_TOKEN: "a b" }, { WA_APP_SECRET: "a\nb" }, { LAUNCH_MODE: "prod" }, { WA_APP_SECRET: 5 }, { WA_APP_SECRET: "" }, { WA_APP_SECRET: "x".repeat(5000) }]) {
      assert.equal(validateSecrets(bad, false).ok, false, JSON.stringify(Object.keys(bad)));
    }
    assert.equal(validateSecrets([], false).ok, false);
    assert.equal(validateSecrets(null, false).ok, false);
  });
  it("errors never contain the value", () => {
    const r = validateSecrets({ MCP_TOKEN: "tooshort-secret-xyz" }, false);
    assert.equal(r.ok, true); // 19 chars is fine
    const r2 = validateSecrets({ MCP_TOKEN: "tiny-secret" }, false);
    assert.equal(r2.ok, false);
    assert.ok(!JSON.stringify(r2).includes("tiny-secret"));
  });
  it("null deletes only on rotation, never ADMIN_TOKEN", () => {
    assert.equal(validateSecrets({ TEST_RECIPIENTS: null }, false).ok, false);
    assert.equal(validateSecrets({ TEST_RECIPIENTS: null }, true).ok, true);
    assert.equal(validateSecrets({ ADMIN_TOKEN: null }, true).ok, false);
  });
});

describe("mergeEnv / sources", () => {
  const stored = { WA_APP_SECRET: "stored-secret-value", LAUNCH_MODE: "live", TEST_RECIPIENTS: "1555" };
  it("env wins over stored, empty env falls back to stored, other env passes through", () => {
    const m = mergeEnv({ WA_APP_SECRET: "env-secret", LAUNCH_MODE: "  ", STATE: {}, WAKE_DEBOUNCE_MS: "0" }, stored);
    assert.equal(m.WA_APP_SECRET, "env-secret");
    assert.equal(m.LAUNCH_MODE, "live");
    assert.equal(m.TEST_RECIPIENTS, "1555");
    assert.equal(m.WAKE_DEBOUNCE_MS, "0");
    assert.equal("STATE" in m, false);
  });
  it("stored values reach loadConfig; an env LAUNCH_MODE=test cannot be flipped by storage", () => {
    assert.equal(loadConfig(mergeEnv({}, stored)).launchMode, "live");
    assert.equal(loadConfig(mergeEnv({ LAUNCH_MODE: "test" }, stored)).launchMode, "test");
    assert.deepEqual(loadConfig(mergeEnv({}, stored)).testRecipients, ["1555"]);
    assert.equal(loadConfig(mergeEnv({}, stored)).waAppSecret, "stored-secret-value");
  });
  it("sources reports names only", () => {
    const s = sources({ WA_APP_SECRET: "x", WAKE_KEY: "" }, stored);
    assert.equal(s.WA_APP_SECRET, "env");
    assert.equal(s.LAUNCH_MODE, "stored");
    assert.equal(s.WAKE_KEY, "unset");
    assert.ok(!JSON.stringify(s).includes("stored-secret-value"));
  });
});
