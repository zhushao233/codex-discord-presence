import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitForLine(stream) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stream });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error("Timed out waiting for MCP stdout"));
    }, 3000);

    rl.once("line", (line) => {
      clearTimeout(timer);
      rl.close();
      resolve(line);
    });
  });
}

test("stdio server speaks newline-delimited MCP JSON", async () => {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_DISCORD_PRESENCE_CONFIG: path.join(root, ".test-missing-config.json"),
    },
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "1.0.0" },
        },
      })}\n`
    );

    const responseLine = await waitForLine(child.stdout);
    const response = JSON.parse(responseLine);
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "codex-discord-presence");
  } finally {
    child.kill();
  }
});
