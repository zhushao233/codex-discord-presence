import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  DiscordIpcClient,
  Opcode,
  encodeFrame,
} from "../server/discord-ipc.js";
import { createClient, createFakeDiscord } from "../test-support/fake-discord.js";

test("DiscordIpcClient handshakes, sets activity, clears activity, and answers PING", async () => {
  const discord = await createFakeDiscord();
  const client = createClient(discord.port);

  try {
    await client.connect();
    assert.equal(client.isReady, true);
    assert.deepEqual(discord.state.handshakes[0], {
      v: 1,
      client_id: "123456789012345678",
    });

    const activity = {
      type: 0,
      details: "Pair programming with ChatGPT",
      state: "Building with Codex",
      timestamps: { start: Date.now() },
    };
    await client.setActivity(activity);
    assert.deepEqual(discord.state.activities[0], activity);

    await client.clearActivity();
    assert.equal(discord.state.activities[1], undefined);

    const [socket] = [...discord.state.sockets];
    socket.write(
      encodeFrame(Opcode.PING, { test: "keepalive" })
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(discord.state.pongs[0], { test: "keepalive" });
  } finally {
    await client.close();
    await discord.close();
  }
});

test(
  "DiscordIpcClient uses the default Windows named-pipe transport",
  { skip: process.platform !== "win32" },
  async () => {
    const pipePath = `\\\\?\\pipe\\codex-discord-presence-test-${process.pid}-${Date.now()}`;
    const discord = await createFakeDiscord({ listenPath: pipePath });
    const client = createClient(pipePath);

    try {
      await client.connect();
      assert.equal(client.isReady, true);
      await client.setActivity({ details: "Named pipe test" });
      assert.equal(discord.state.activities[0].details, "Named pipe test");
    } finally {
      await client.close();
      await discord.close();
    }
  }
);

test("DiscordIpcClient retries a transient connection failure", async () => {
  const discord = await createFakeDiscord();
  let attempts = 0;
  const client = new DiscordIpcClient({
    clientId: "123456789012345678",
    pipePaths: ["retry-test"],
    connectAttempts: 3,
    connectRetryDelayMs: 10,
    connectTimeoutMs: 1000,
    handshakeTimeoutMs: 1000,
    responseTimeoutMs: 1000,
    connectToPath: () => {
      attempts += 1;
      if (attempts === 1) {
        const socket = new net.Socket();
        queueMicrotask(() => {
          const error = new Error("connect ENOENT retry-test");
          error.code = "ENOENT";
          socket.destroy(error);
        });
        return socket;
      }
      return net.createConnection({
        host: "127.0.0.1",
        port: discord.port,
      });
    },
  });

  try {
    await client.connect();
    assert.equal(attempts, 2);
    assert.equal(client.isReady, true);
  } finally {
    await client.close();
    await discord.close();
  }
});

test("DiscordIpcClient reports the attempt count when Discord stays unavailable", async () => {
  let attempts = 0;
  const client = new DiscordIpcClient({
    clientId: "123456789012345678",
    pipePaths: ["missing-test"],
    connectAttempts: 2,
    connectRetryDelayMs: 1,
    connectToPath: () => {
      attempts += 1;
      const socket = new net.Socket();
      queueMicrotask(() => {
        const error = new Error("connect ENOENT missing-test");
        error.code = "ENOENT";
        socket.destroy(error);
      });
      return socket;
    },
  });

  await assert.rejects(
    () => client.connect(),
    (error) =>
      error.code === "DISCORD_NOT_RUNNING" &&
      error.message.includes("after 2 attempts")
  );
  assert.equal(attempts, 2);
});
