import net from "node:net";
import {
  DiscordIpcClient,
  FrameDecoder,
  Opcode,
  encodeFrame,
} from "../server/discord-ipc.js";

export async function createFakeDiscord({ listenPath } = {}) {
  const state = {
    handshakes: [],
    activities: [],
    pongs: [],
    sockets: new Set(),
  };

  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    const decoder = new FrameDecoder();

    socket.on("close", () => state.sockets.delete(socket));
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.op === Opcode.HANDSHAKE) {
          state.handshakes.push(frame.data);
          socket.write(
            encodeFrame(Opcode.FRAME, {
              cmd: "DISPATCH",
              evt: "READY",
              data: { v: 1, user: { id: "1", username: "tester" } },
            })
          );
          continue;
        }

        if (frame.op === Opcode.FRAME && frame.data?.cmd === "SET_ACTIVITY") {
          state.activities.push(frame.data.args.activity);
          socket.write(
            encodeFrame(Opcode.FRAME, {
              cmd: "SET_ACTIVITY",
              evt: null,
              nonce: frame.data.nonce,
              data: frame.data.args.activity,
            })
          );
          continue;
        }

        if (frame.op === Opcode.PONG) {
          state.pongs.push(frame.data);
          continue;
        }

        if (frame.op === Opcode.CLOSE) {
          socket.end();
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (listenPath) {
      server.listen(listenPath, resolve);
    } else {
      server.listen(0, "127.0.0.1", resolve);
    }
  });

  return {
    port: server.address().port,
    path: listenPath ?? null,
    state,
    close: async () => {
      for (const socket of state.sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function createClient(target) {
  const tcpOptions =
    typeof target === "number"
      ? {
          pipePaths: ["fake-discord-ipc"],
          connectToPath: () =>
            net.createConnection({ host: "127.0.0.1", port: target }),
        }
      : {
          pipePaths: [target],
        };

  return new DiscordIpcClient({
    clientId: "123456789012345678",
    ...tcpOptions,
    connectTimeoutMs: 1000,
    handshakeTimeoutMs: 1000,
    responseTimeoutMs: 1000,
  });
}
