#!/usr/bin/env node

import readline from "node:readline";
import { McpServer } from "./mcp-server.js";
import { PresenceService } from "./presence-service.js";
import { readConfig, writeConfig } from "./config.js";

const SERVER_NAME = "codex-discord-presence";
const SERVER_VERSION = "1.0.2";

const INSTRUCTIONS = [
  "This local plugin controls Discord Rich Presence on the user's computer.",
  "Before showing activity, call get_discord_presence_status.",
  "If it is not configured, ask for the user's Discord Application ID (never a bot token or password) and call configure_discord_app.",
  "Discord shows 'Playing <application name>', so the Discord application must be named Codex for the exact 'Playing Codex' label.",
  "Only claim success when the tool result has connected=true.",
  "Use clear_discord_activity when the user asks to remove the activity.",
].join(" ");

function writeMessage(message) {
  if (message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

async function runStdioServer() {
  const service = new PresenceService();
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    instructions: INSTRUCTIONS,
    service,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      return;
    }

    try {
      const response = await server.handleMessage(message);
      writeMessage(response);
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32603, message: error.message ?? "Internal error." },
      });
    }
  });

  const shutdown = async () => {
    await service.disconnect();
    rl.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  const service = new PresenceService();

  if (command === "--set-client-id") {
    const clientId = args[0];
    const applicationName = args[1] || "Codex";
    const saved = writeConfig({ clientId, applicationName });
    console.log(
      `Saved Discord application ${saved.applicationName} (ID ending ${saved.clientId.slice(-4)}) to ${saved.configPath}`
    );
    return;
  }

  if (command === "--status") {
    const status = await service.status({ probe: true });
    console.log(JSON.stringify(status, null, 2));
    await service.disconnect();
    return;
  }

  if (command === "--show") {
    const details = args[0];
    const state = args[1];
    const status = await service.show({ details, state });
    console.log(JSON.stringify(status, null, 2));
    await service.disconnect();
    return;
  }

  if (command === "--clear") {
    const status = await service.clear();
    console.log(JSON.stringify(status, null, 2));
    await service.disconnect();
    return;
  }

  if (command === "--print-config") {
    console.log(JSON.stringify(readConfig(), null, 2));
    return;
  }

  await runStdioServer();
}

runCli().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
