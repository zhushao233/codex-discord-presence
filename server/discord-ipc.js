import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";

export const Opcode = Object.freeze({
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
});

const MAX_FRAME_BYTES = 1024 * 1024;

export class DiscordIpcError extends Error {
  constructor(message, { code = "DISCORD_IPC_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "DiscordIpcError";
    this.code = code;
  }
}

export function getDiscordPipePath(id, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    return `\\\\?\\pipe\\discord-ipc-${id}`;
  }

  const prefix = (
    env.XDG_RUNTIME_DIR ||
    env.TMPDIR ||
    env.TMP ||
    env.TEMP ||
    os.tmpdir()
  ).replace(/[\\/]+$/, "");
  return `${prefix}/discord-ipc-${id}`;
}

export function encodeFrame(op, data) {
  const json = JSON.stringify(data ?? {});
  const payload = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeInt32LE(op, 0);
  frame.writeInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

export class FrameDecoder {
  constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("FrameDecoder.push expects a Buffer");
    }

    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const frames = [];
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);

      if (length < 0 || length > this.maxFrameBytes) {
        throw new DiscordIpcError(
          `Discord sent an invalid IPC frame length: ${length}`,
          { code: "INVALID_FRAME" }
        );
      }

      if (this.buffer.length < 8 + length) {
        break;
      }

      const payload = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);

      let data = null;
      if (length > 0) {
        try {
          data = JSON.parse(payload.toString("utf8"));
        } catch (error) {
          throw new DiscordIpcError("Discord sent invalid JSON over IPC.", {
            code: "INVALID_JSON",
            cause: error,
          });
        }
      }

      frames.push({ op, data });
    }

    return frames;
  }
}

function discordErrorMessage(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data && typeof data.message === "string") {
    return data.message;
  }
  return "Discord rejected the Rich Presence request.";
}

export class DiscordIpcClient extends EventEmitter {
  constructor(options = {}) {
    super();

    if (!options.clientId) {
      throw new TypeError("DiscordIpcClient requires a clientId");
    }

    this.clientId = String(options.clientId);
    this.pid = options.pid ?? process.pid;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1200;
    this.connectAttempts = Math.max(1, options.connectAttempts ?? 4);
    this.connectRetryDelayMs = Math.max(
      0,
      options.connectRetryDelayMs ?? 750
    );
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 5000;
    this.connectToPath =
      options.connectToPath ?? ((pipePath) => net.createConnection(pipePath));
    this.pipePaths =
      options.pipePaths ??
      Array.from({ length: 10 }, (_, id) => getDiscordPipePath(id));

    this.socket = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.connectPromise = null;
    this.ready = false;
    this.closing = false;
    this.lastError = null;
    this.readyWaiter = null;
  }

  get isReady() {
    return this.ready && Boolean(this.socket) && !this.closing;
  }

  async connect() {
    if (this.isReady) {
      return this;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.#connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async #connectInternal() {
    this.closing = false;
    let lastError = null;

    for (let attempt = 0; attempt < this.connectAttempts; attempt += 1) {
      for (const pipePath of this.pipePaths) {
        let socket = null;
        try {
          socket = await this.#openSocket(pipePath);
          this.socket = socket;
          this.decoder = new FrameDecoder();
          this.#attachSocket(socket);
          await this.#handshake();
          this.ready = true;
          this.lastError = null;
          this.emit("ready");
          return this;
        } catch (error) {
          lastError = error;
          this.ready = false;
          if (socket) {
            socket.removeAllListeners();
            socket.destroy();
          }
          this.socket = null;
        }
      }

      if (attempt + 1 < this.connectAttempts && this.connectRetryDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.connectRetryDelayMs)
        );
      }
    }

    const error = new DiscordIpcError(
      `Could not connect to Discord after ${this.connectAttempts} attempts. Open the Discord desktop app, make sure it is fully started, then try again.`,
      { code: "DISCORD_NOT_RUNNING", cause: lastError }
    );
    this.lastError = error;
    throw error;
  }

  #openSocket(pipePath) {
    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;

      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve(socket);
        }
      };

      const onConnect = () => finish(null);
      const onError = (error) => finish(error);
      const timer = setTimeout(() => {
        finish(
          new DiscordIpcError(`Timed out connecting to ${pipePath}.`, {
            code: "DISCORD_CONNECT_TIMEOUT",
          })
        );
      }, this.connectTimeoutMs);

      try {
        socket = this.connectToPath(pipePath);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  #attachSocket(socket) {
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (error) {
        this.#disconnect(error);
        return;
      }

      for (const frame of frames) {
        this.#handleFrame(frame);
      }
    });

    socket.on("error", (error) => {
      this.#disconnect(
        new DiscordIpcError(`Discord IPC connection failed: ${error.message}`, {
          code: "DISCORD_SOCKET_ERROR",
          cause: error,
        })
      );
    });

    socket.on("close", () => {
      this.#disconnect(
        new DiscordIpcError("Discord closed the IPC connection.", {
          code: "DISCORD_DISCONNECTED",
        })
      );
    });
  }

  #handleFrame({ op, data }) {
    if (op === Opcode.PING) {
      this.#sendRaw(data, Opcode.PONG);
      return;
    }

    if (op === Opcode.PONG) {
      return;
    }

    if (op === Opcode.CLOSE) {
      this.#disconnect(
        new DiscordIpcError("Discord closed the IPC session.", {
          code: "DISCORD_CLOSED",
        })
      );
      return;
    }

    if (op !== Opcode.FRAME || !data) {
      return;
    }

    if (this.readyWaiter && data.evt === "READY") {
      this.readyWaiter.resolve(data);
      this.readyWaiter = null;
      return;
    }

    if (this.readyWaiter && data.evt === "ERROR") {
      this.readyWaiter.reject(
        new DiscordIpcError(discordErrorMessage(data.data), {
          code: "DISCORD_HANDSHAKE_REJECTED",
        })
      );
      this.readyWaiter = null;
      return;
    }

    if (data.nonce && this.pending.has(data.nonce)) {
      const pending = this.pending.get(data.nonce);
      this.pending.delete(data.nonce);
      clearTimeout(pending.timer);

      if (data.evt === "ERROR") {
        pending.reject(
          new DiscordIpcError(discordErrorMessage(data.data), {
            code: "DISCORD_RPC_REJECTED",
          })
        );
      } else {
        pending.resolve(data.data ?? null);
      }
      return;
    }

    if (data.evt === "ERROR") {
      this.emit(
        "rpcError",
        new DiscordIpcError(discordErrorMessage(data.data), {
          code: "DISCORD_RPC_ERROR",
        })
      );
    }
  }

  async #handshake() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(
          new DiscordIpcError(
            "Discord did not complete the Rich Presence handshake.",
            { code: "DISCORD_HANDSHAKE_TIMEOUT" }
          )
        );
      }, this.handshakeTimeoutMs);

      this.readyWaiter = {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };

      try {
        this.#sendRaw(
          { v: 1, client_id: this.clientId },
          Opcode.HANDSHAKE
        );
      } catch (error) {
        clearTimeout(timer);
        this.readyWaiter = null;
        reject(error);
      }
    });
  }

  async #request(command, args) {
    await this.connect();

    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(
          new DiscordIpcError(
            `Discord did not answer the ${command} request in time.`,
            { code: "DISCORD_RESPONSE_TIMEOUT" }
          )
        );
      }, this.responseTimeoutMs);

      this.pending.set(nonce, { resolve, reject, timer });

      try {
        this.#sendRaw({ cmd: command, args, nonce }, Opcode.FRAME);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(nonce);
        reject(error);
      }
    });
  }

  async setActivity(activity) {
    return this.#request("SET_ACTIVITY", {
      pid: this.pid,
      activity,
    });
  }

  async clearActivity() {
    return this.#request("SET_ACTIVITY", {
      pid: this.pid,
    });
  }

  #sendRaw(data, op) {
    if (!this.socket || this.socket.destroyed) {
      throw new DiscordIpcError("Discord IPC is not connected.", {
        code: "DISCORD_NOT_CONNECTED",
      });
    }

    this.socket.write(encodeFrame(op, data));
  }

  #disconnect(error) {
    const wasReady = this.ready;
    this.ready = false;
    this.lastError = error;

    if (this.socket) {
      this.socket.removeAllListeners();
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      this.socket = null;
    }

    if (this.readyWaiter) {
      this.readyWaiter.reject(error);
      this.readyWaiter = null;
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    if (wasReady && !this.closing) {
      this.emit("close", error);
    }
  }

  async close() {
    this.closing = true;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.#sendRaw({}, Opcode.CLOSE);
      } catch {
        // The socket may already be gone; destroying it is enough.
      }
      this.socket.end();
      this.socket.destroy();
    }
    this.#disconnect(
      new DiscordIpcError("Discord IPC client closed.", {
        code: "DISCORD_CLIENT_CLOSED",
      })
    );
  }
}
