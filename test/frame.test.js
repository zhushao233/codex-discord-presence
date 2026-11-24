import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameDecoder,
  Opcode,
  encodeFrame,
  getDiscordPipePath,
} from "../server/discord-ipc.js";

test("encodeFrame and FrameDecoder round-trip a payload", () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame(Opcode.FRAME, {
    cmd: "SET_ACTIVITY",
    data: { details: "Working with Codex", nonce: "abc" },
  });

  const decoded = decoder.push(frame);
  assert.deepEqual(decoded, [
    {
      op: Opcode.FRAME,
      data: {
        cmd: "SET_ACTIVITY",
        data: { details: "Working with Codex", nonce: "abc" },
      },
    },
  ]);
});

test("FrameDecoder handles split and concatenated frames", () => {
  const decoder = new FrameDecoder();
  const first = encodeFrame(Opcode.PING, { value: 1 });
  const second = encodeFrame(Opcode.FRAME, { evt: "READY" });
  const combined = Buffer.concat([first, second]);

  assert.deepEqual(decoder.push(combined.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(combined.subarray(5, 11)), []);
  assert.deepEqual(decoder.push(combined.subarray(11)), [
    { op: Opcode.PING, data: { value: 1 } },
    { op: Opcode.FRAME, data: { evt: "READY" } },
  ]);
});

test("FrameDecoder rejects invalid lengths", () => {
  const decoder = new FrameDecoder({ maxFrameBytes: 8 });
  const frame = Buffer.alloc(8);
  frame.writeInt32LE(Opcode.FRAME, 0);
  frame.writeInt32LE(9, 4);

  assert.throws(() => decoder.push(frame), /invalid IPC frame length/);
});

test("getDiscordPipePath follows the Discord desktop conventions", () => {
  assert.equal(
    getDiscordPipePath(2, { platform: "win32", env: {} }),
    "\\\\?\\pipe\\discord-ipc-2"
  );
  assert.equal(
    getDiscordPipePath(3, {
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    }),
    "/run/user/1000/discord-ipc-3"
  );
});
