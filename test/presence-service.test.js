import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PresenceService } from "../server/presence-service.js";
import { writeConfig } from "../server/config.js";
import { createClient, createFakeDiscord } from "../test-support/fake-discord.js";

function createServiceEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-presence-service-"));
  const configPath = path.join(dir, "config.json");
  writeConfig(
    {
      clientId: "123456789012345678",
      applicationName: "Codex",
    },
    { env: { CODEX_DISCORD_PRESENCE_CONFIG: configPath } }
  );
  return {
    env: { CODEX_DISCORD_PRESENCE_CONFIG: configPath },
    configPath,
  };
}

test("PresenceService connects, shows activity, reports status, and clears", async () => {
  const discord = await createFakeDiscord();
  const { env } = createServiceEnvironment();
  const service = new PresenceService({
    env,
    clientFactory: () => createClient(discord.port),
  });

  try {
    const status = await service.status();
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.equal(status.applicationName, "Codex");

    const shown = await service.show({
      details: "Pair programming with ChatGPT",
      state: "Building with Codex",
    });
    assert.equal(shown.ok, true);
    assert.equal(shown.currentActivity.summary, "Playing Codex");
    assert.equal(discord.state.activities[0].details, "Pair programming with ChatGPT");
    assert.equal(discord.state.activities[0].state, "Building with Codex");

    const afterShow = await service.status();
    assert.equal(afterShow.currentActivity.summary, "Playing Codex");
    assert.equal(afterShow.connected, true);

    const cleared = await service.clear();
    assert.equal(cleared.cleared, true);
    assert.equal(discord.state.activities.at(-1), undefined);
    assert.equal((await service.status()).currentActivity, null);
  } finally {
    await service.disconnect();
    await discord.close();
  }
});

test("PresenceService reports an unconfigured installation without inventing a connection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-presence-empty-"));
  const service = new PresenceService({
    env: {
      CODEX_DISCORD_PRESENCE_CONFIG: path.join(dir, "missing.json"),
    },
  });

  const status = await service.status();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.currentActivity, null);

  await assert.rejects(
    () => service.show(),
    (error) => error.code === "DISCORD_NOT_CONFIGURED"
  );
});
