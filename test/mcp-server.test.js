import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "../server/mcp-server.js";

function createFakeService() {
  return {
    client: null,
    async show(args) {
      return {
        ok: true,
        configured: true,
        connected: true,
        applicationName: "Codex",
        clientIdSuffix: "5678",
        currentActivity: {
          applicationName: "Codex",
          summary: "Playing Codex",
          details: args.details ?? "Pair programming with ChatGPT",
          state: args.state ?? "Building with Codex",
          startedAt: "2026-11-22T00:00:00.000Z",
        },
      };
    },
    async status() {
      return {
        configured: true,
        connected: true,
        applicationName: "Codex",
        clientIdSuffix: "5678",
        currentActivity: {
          applicationName: "Codex",
          summary: "Playing Codex",
          details: "Pair programming with ChatGPT",
          state: "Building with Codex",
          startedAt: "2026-11-22T00:00:00.000Z",
        },
        startedAt: "2026-11-22T00:00:00.000Z",
        configPath: "C:\\Users\\tester\\.codex-discord-presence\\config.json",
        error: null,
      };
    },
    async configure(args) {
      return {
        ok: true,
        configured: true,
        applicationName: args.applicationName ?? "Codex",
        clientIdSuffix: String(args.clientId).slice(-4),
        configPath: "C:\\Users\\tester\\.codex-discord-presence\\config.json",
        message: "Discord application saved locally.",
      };
    },
    async clear() {
      return {
        ok: true,
        configured: true,
        connected: true,
        cleared: true,
        message: "Discord activity cleared.",
      };
    },
  };
}

function createServer() {
  return new McpServer({
    name: "codex-discord-presence",
    version: "1.0.0",
    instructions: "Test instructions",
    service: createFakeService(),
  });
}

test("initialize advertises tools and preserves a supported protocol version", async () => {
  const server = createServer();
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  });

  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(response.result.serverInfo.name, "codex-discord-presence");
  assert.equal(response.result.capabilities.tools.listChanged, false);
  assert.equal(response.result.instructions, "Test instructions");
});

test("tools/list exposes focused presence tools with annotations", async () => {
  const server = createServer();
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "show_codex_activity",
    "get_discord_presence_status",
    "configure_discord_app",
    "clear_discord_activity",
  ]);

  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
  }
});

test("tools/call returns structured content and text", async () => {
  const server = createServer();
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "show_codex_activity",
      arguments: {
        details: "Pair programming",
        state: "Shipping a plugin",
      },
    },
  });

  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.connected, true);
  assert.equal(response.result.structuredContent.currentActivity.summary, "Playing Codex");
  assert.match(response.result.content[0].text, /Playing Codex/);
});

test("unknown tools return a tool-level error", async () => {
  const server = createServer();
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "does_not_exist", arguments: {} },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Unknown tool/);
});

test("notifications are acknowledged without a response", async () => {
  const server = createServer();
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });

  assert.equal(response, null);
  assert.equal(server.initialized, true);
});
