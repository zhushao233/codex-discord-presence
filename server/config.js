import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_ID_PATTERN = /^\d{15,25}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.code = "INVALID_CONFIG";
  }
}

export function resolveConfigPath(env = process.env) {
  return (
    env.CODEX_DISCORD_PRESENCE_CONFIG ||
    path.join(os.homedir(), ".codex-discord-presence", "config.json")
  );
}

export function normalizeClientId(value) {
  const clientId = String(value ?? "").trim();
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new ConfigError(
      "Discord client ID must be the 15-25 digit Application ID from the Discord Developer Portal."
    );
  }
  return clientId;
}

export function normalizeApplicationName(value) {
  const name = String(value ?? "Codex").trim();
  if (!name) {
    throw new ConfigError("Discord application name cannot be empty.");
  }
  if (name.length > 64) {
    throw new ConfigError("Discord application name must be 64 characters or fewer.");
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new ConfigError("Discord application name contains invalid characters.");
  }
  return name;
}

export function readConfig(options = {}) {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveConfigPath(env);

  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new ConfigError(
        `Could not read the local Discord presence config at ${configPath}: ${error.message}`
      );
    }
  }

  const rawClientId = env.DISCORD_CLIENT_ID || fileConfig.clientId || "";
  const rawApplicationName =
    env.DISCORD_APPLICATION_NAME || fileConfig.applicationName || "Codex";

  let clientId = null;
  let applicationName = normalizeApplicationName(rawApplicationName);

  if (rawClientId) {
    clientId = normalizeClientId(rawClientId);
  }

  return {
    clientId,
    applicationName,
    configPath,
    source: env.DISCORD_CLIENT_ID ? "environment" : fileConfig.clientId ? "file" : "none",
  };
}

export function writeConfig(
  { clientId, applicationName = "Codex" },
  options = {}
) {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveConfigPath(env);
  const config = {
    clientId: normalizeClientId(clientId),
    applicationName: normalizeApplicationName(applicationName),
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    ...config,
    configPath,
  };
}
