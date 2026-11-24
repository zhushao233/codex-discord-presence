import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigError,
  normalizeApplicationName,
  normalizeClientId,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "../server/config.js";

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discord-presence-"));
  return path.join(dir, "config.json");
}

test("writeConfig and readConfig persist a valid local config", () => {
  const configPath = tempConfigPath();
  const env = { CODEX_DISCORD_PRESENCE_CONFIG: configPath };

  writeConfig(
    {
      clientId: "123456789012345678",
      applicationName: "Codex",
    },
    { env }
  );

  const config = readConfig({ env });
  assert.equal(config.clientId, "123456789012345678");
  assert.equal(config.applicationName, "Codex");
  assert.equal(config.source, "file");
  assert.equal(config.configPath, configPath);

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(raw, {
    clientId: "123456789012345678",
    applicationName: "Codex",
  });
});

test("environment variables override the local config file", () => {
  const configPath = tempConfigPath();
  const config = readConfig({
    env: {
      CODEX_DISCORD_PRESENCE_CONFIG: configPath,
      DISCORD_CLIENT_ID: "223456789012345678",
      DISCORD_APPLICATION_NAME: "Codex Activity",
    },
  });

  assert.equal(config.clientId, "223456789012345678");
  assert.equal(config.applicationName, "Codex Activity");
  assert.equal(config.source, "environment");
});

test("client ID and application name validation reject unsafe values", () => {
  assert.throws(() => normalizeClientId("not-an-id"), ConfigError);
  assert.throws(() => normalizeClientId("123"), ConfigError);
  assert.throws(() => normalizeApplicationName(""), ConfigError);
  assert.throws(() => normalizeApplicationName("Codex\nInjected"), ConfigError);
  assert.throws(() => normalizeApplicationName("x".repeat(65)), ConfigError);
});

test("resolveConfigPath defaults to the user home directory", () => {
  const configPath = resolveConfigPath({});
  assert.ok(configPath.endsWith(path.join(".codex-discord-presence", "config.json")));
});
