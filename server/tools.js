import { ConfigError } from "./config.js";

export const TOOL_DEFINITIONS = [
  {
    name: "show_codex_activity",
    title: "Show Codex activity in Discord",
    description:
      "Use when the user wants their Discord profile to show that they are playing Codex while using ChatGPT or Codex. Requires the Discord desktop app and a locally configured Discord application ID.",
    inputSchema: {
      type: "object",
      properties: {
        details: {
          type: "string",
          maxLength: 128,
          description:
            "Optional first line of the Discord activity. Defaults to Pair programming with ChatGPT.",
        },
        state: {
          type: "string",
          maxLength: 128,
          description:
            "Optional second line of the Discord activity. Defaults to Building with Codex.",
        },
        resetTimer: {
          type: "boolean",
          description:
            "When true, reset the elapsed-time counter shown in Discord.",
          default: false,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        configured: { type: "boolean" },
        connected: { type: "boolean" },
        applicationName: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        clientIdSuffix: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        currentActivity: {
          anyOf: [
            {
              type: "object",
              properties: {
                applicationName: { type: "string" },
                summary: { type: "string" },
                details: { type: "string" },
                state: { type: "string" },
                startedAt: { type: "string" },
              },
              required: ["applicationName", "summary", "details", "state", "startedAt"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
        error: {
          anyOf: [
            {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
              required: ["code", "message"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
      required: ["ok", "configured", "connected", "applicationName", "clientIdSuffix", "currentActivity"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_discord_presence_status",
    title: "Check Discord presence status",
    description:
      "Use before Discord presence setup or when the Presence feature is not working. Returns local configuration and Discord IPC connection state; it does not read other Discord users' activity.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        configured: { type: "boolean" },
        connected: { type: "boolean" },
        applicationName: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        clientIdSuffix: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        currentActivity: {
          anyOf: [{ type: "object" }, { type: "null" }],
        },
        startedAt: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        configPath: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        error: {
          anyOf: [
            {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
              required: ["code", "message"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
      required: ["configured", "connected", "applicationName", "clientIdSuffix", "currentActivity", "startedAt", "configPath"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "configure_discord_app",
    title: "Configure Discord application",
    description:
      "Use only during initial setup when the user supplies the Application ID from their own Discord Developer Portal app. Saves the public client ID locally. Never ask for or accept a bot token, password, or Discord login.",
    inputSchema: {
      type: "object",
      properties: {
        clientId: {
          type: "string",
          pattern: "^\\d{15,25}$",
          description:
            "Discord Application ID from General Information in the Discord Developer Portal.",
        },
        applicationName: {
          type: "string",
          maxLength: 64,
          default: "Codex",
          description:
            "The name of the Discord application. Discord shows Playing followed by this name.",
        },
      },
      required: ["clientId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        configured: { type: "boolean" },
        applicationName: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        clientIdSuffix: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        configPath: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        message: { type: "string" },
      },
      required: ["ok", "configured", "applicationName", "clientIdSuffix", "configPath", "message"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "clear_discord_activity",
    title: "Clear Discord activity",
    description:
      "Use when the user wants to remove the Playing Codex activity from Discord.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        configured: { type: "boolean" },
        connected: { type: "boolean" },
        cleared: { type: "boolean" },
        message: { type: "string" },
      },
      required: ["ok", "configured", "connected", "cleared", "message"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function result(text, structuredContent, options = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(options.isError ? { isError: true } : {}),
  };
}

function errorResult(error) {
  const code = error?.code ?? "PRESENCE_ERROR";
  const message = error?.message ?? String(error);

  return result(
    `Discord presence failed: ${message}`,
    {
      ok: false,
      configured: false,
      connected: false,
      applicationName: null,
      clientIdSuffix: null,
      currentActivity: null,
      error: { code, message },
    },
    { isError: true }
  );
}

export function createToolHandlers(service) {
  return {
    async show_codex_activity(args = {}) {
      try {
        if (args.details !== undefined && typeof args.details !== "string") {
          throw new ConfigError("details must be a string.");
        }
        if (args.state !== undefined && typeof args.state !== "string") {
          throw new ConfigError("state must be a string.");
        }
        if (args.resetTimer !== undefined && typeof args.resetTimer !== "boolean") {
          throw new ConfigError("resetTimer must be a boolean.");
        }

        const status = await service.show({
          details: args.details,
          state: args.state,
          resetTimer: args.resetTimer ?? false,
        });
        return result(
          `Discord is now showing "${status.currentActivity.summary}".`,
          status
        );
      } catch (error) {
        if (
          error?.code === "DISCORD_NOT_CONFIGURED" ||
          error?.code === "DISCORD_NOT_RUNNING"
        ) {
          return result(
            `${error.message} Run the setup skill to configure Discord, then make sure the Discord desktop app is open.`,
            {
              ok: false,
              configured: error.code !== "DISCORD_NOT_CONFIGURED",
              connected: false,
              applicationName: null,
              clientIdSuffix: null,
              currentActivity: null,
              error: { code: error.code, message: error.message },
            },
            { isError: true }
          );
        }
        return errorResult(error);
      }
    },

    async get_discord_presence_status() {
      const status = await service.status({ probe: true });
      let text;
      if (!status.configured) {
        text =
          "Discord presence is not configured. A Discord application client ID is required.";
      } else if (status.connected) {
        text = `Discord presence is connected${status.currentActivity ? ` and showing "${status.currentActivity.summary}"` : ""}.`;
      } else {
        text = `Discord presence is configured but not connected: ${status.error?.message ?? "Discord desktop is not available."}`;
      }

      return result(text, status, {
        isError: Boolean(status.configured && !status.connected),
      });
    },

    async configure_discord_app(args = {}) {
      try {
        const configured = await service.configure({
          clientId: args.clientId,
          applicationName: args.applicationName ?? "Codex",
        });
        return result(
          `${configured.message} The same name must be set on the Discord application for the status to read "Playing ${configured.applicationName}".`,
          configured
        );
      } catch (error) {
        return result(
          `Could not save the Discord configuration: ${error.message}`,
          {
            ok: false,
            configured: false,
            applicationName: null,
            clientIdSuffix: null,
            configPath: null,
            message: error.message,
          },
          { isError: true }
        );
      }
    },

    async clear_discord_activity() {
      try {
        const cleared = await service.clear();
        return result(cleared.message, cleared);
      } catch (error) {
        return result(
          `Could not clear Discord activity: ${error.message}`,
          {
            ok: false,
            configured: true,
            connected: Boolean(service.client?.isReady),
            cleared: false,
            message: error.message,
          },
          { isError: true }
        );
      }
    },
  };
}
