import { readConfig, writeConfig } from "./config.js";
import {
  DiscordIpcClient,
  DiscordIpcError,
} from "./discord-ipc.js";

const MAX_ACTIVITY_TEXT = 128;

function normalizeActivityText(value, fallback) {
  const text = String(value ?? fallback ?? "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, MAX_ACTIVITY_TEXT).join("");
}

function clientIdSuffix(clientId) {
  return clientId ? clientId.slice(-4) : null;
}

function publicError(error) {
  return {
    code: error?.code ?? "PRESENCE_ERROR",
    message: error?.message ?? String(error),
  };
}

export class PresenceService {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.clientFactory =
      options.clientFactory ??
      ((config) =>
        new DiscordIpcClient({
          clientId: config.clientId,
          pipePaths: config.pipePaths,
          connectToPath: config.connectToPath,
        }));
    this.client = null;
    this.currentActivity = null;
    this.startedAt = null;
    this.lastError = null;
  }

  getConfig() {
    return readConfig({ env: this.env });
  }

  async #ensureClient(config) {
    if (this.client?.isReady) {
      return this.client;
    }

    if (!config.clientId) {
      throw new DiscordIpcError(
        "Discord presence is not configured yet. Add a Discord application client ID first.",
        { code: "DISCORD_NOT_CONFIGURED" }
      );
    }

    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }

    const client = this.clientFactory({
      clientId: config.clientId,
      applicationName: config.applicationName,
    });
    client.on("close", (error) => {
      this.lastError = error;
    });
    await client.connect();
    this.client = client;
    this.lastError = null;
    return client;
  }

  async status({ probe = true } = {}) {
    let config;
    try {
      config = this.getConfig();
    } catch (error) {
      return {
        configured: false,
        connected: false,
        applicationName: null,
        clientIdSuffix: null,
        currentActivity: null,
        startedAt: null,
        configPath: null,
        error: publicError(error),
      };
    }

    let connected = Boolean(this.client?.isReady);
    let error = this.lastError ? publicError(this.lastError) : null;

    if (probe && config.clientId && !connected) {
      try {
        await this.#ensureClient(config);
        connected = true;
        error = null;
      } catch (probeError) {
        this.lastError = probeError;
        error = publicError(probeError);
      }
    }

    return {
      configured: Boolean(config.clientId),
      connected,
      applicationName: config.applicationName,
      clientIdSuffix: clientIdSuffix(config.clientId),
      currentActivity: this.currentActivity,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      configPath: config.configPath,
      error,
    };
  }

  async show({ details, state, resetTimer = false } = {}) {
    const config = this.getConfig();
    const client = await this.#ensureClient(config);
    const detailsText = normalizeActivityText(
      details,
      "Pair programming with ChatGPT"
    );
    const stateText = normalizeActivityText(
      state,
      "Building with Codex"
    );

    if (resetTimer || !this.startedAt) {
      this.startedAt = Date.now();
    }

    const activity = {
      type: 0,
      details: detailsText,
      state: stateText,
      timestamps: {
        start: this.startedAt,
      },
      instance: false,
    };

    try {
      await client.setActivity(activity);
    } catch (error) {
      this.lastError = error;
      if (error.code === "DISCORD_DISCONNECTED" || error.code === "DISCORD_SOCKET_ERROR") {
        await this.client?.close().catch(() => {});
        this.client = null;
      }
      throw error;
    }

    this.currentActivity = {
      applicationName: config.applicationName,
      summary: `Playing ${config.applicationName}`,
      details: detailsText,
      state: stateText,
      startedAt: new Date(this.startedAt).toISOString(),
    };
    this.lastError = null;

    return {
      ok: true,
      configured: true,
      connected: true,
      applicationName: config.applicationName,
      clientIdSuffix: clientIdSuffix(config.clientId),
      currentActivity: this.currentActivity,
    };
  }

  async clear() {
    const config = this.getConfig();
    let connected = Boolean(this.client?.isReady);

    if (!config.clientId) {
      this.currentActivity = null;
      this.startedAt = null;
      return {
        ok: true,
        configured: false,
        connected: false,
        cleared: false,
        message: "Discord presence is not configured, so there was nothing to clear.",
      };
    }

    if (!connected) {
      try {
        await this.#ensureClient(config);
        connected = true;
      } catch {
        // If Discord is closed, its activity disappears with the IPC session.
      }
    }

    let cleared = false;
    if (connected && this.client?.isReady) {
      await this.client.clearActivity();
      cleared = true;
    }

    this.currentActivity = null;
    this.startedAt = null;
    this.lastError = null;

    return {
      ok: true,
      configured: true,
      connected,
      cleared,
      message: cleared
        ? "Discord activity cleared."
        : "No active Discord IPC session was available; Discord should no longer show the activity.",
    };
  }

  async configure({ clientId, applicationName = "Codex" }) {
    const saved = writeConfig(
      { clientId, applicationName },
      { env: this.env }
    );

    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this.currentActivity = null;
    this.startedAt = null;
    this.lastError = null;

    return {
      ok: true,
      configured: true,
      applicationName: saved.applicationName,
      clientIdSuffix: clientIdSuffix(saved.clientId),
      configPath: saved.configPath,
      message:
        "Discord application saved locally. The Discord app name controls the Playing ... label.",
    };
  }

  async disconnect() {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }
}
