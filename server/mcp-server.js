import { TOOL_DEFINITIONS, createToolHandlers } from "./tools.js";

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
]);

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function successResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export class McpServer {
  constructor(options) {
    this.name = options.name;
    this.version = options.version;
    this.instructions = options.instructions;
    this.handlers = createToolHandlers(options.service);
    this.initialized = false;
  }

  async handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return errorResponse(message?.id, -32600, "Invalid JSON-RPC request.");
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (isNotification) {
      if (method === "notifications/initialized") {
        this.initialized = true;
      }
      return null;
    }

    try {
      switch (method) {
        case "initialize":
          return successResponse(id, this.#initialize(params ?? {}));

        case "ping":
          return successResponse(id, {});

        case "tools/list":
          return successResponse(id, { tools: TOOL_DEFINITIONS });

        case "tools/call":
          return successResponse(id, await this.#callTool(params ?? {}));

        case "resources/list":
          return successResponse(id, { resources: [] });

        case "prompts/list":
          return successResponse(id, { prompts: [] });

        case "logging/setLevel":
          return successResponse(id, {});

        case "shutdown":
          return successResponse(id, {});

        default:
          return errorResponse(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      return errorResponse(id, -32603, error.message ?? "Internal error.");
    }
  }

  #initialize(params) {
    const requestedVersion = params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : DEFAULT_PROTOCOL_VERSION;

    return {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: this.name,
        version: this.version,
      },
      instructions: this.instructions,
    };
  }

  async #callTool(params) {
    const name = params.name;
    const args = params.arguments ?? {};

    if (typeof name !== "string" || !this.handlers[name]) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name ?? "(missing)"}` }],
        isError: true,
      };
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return {
        content: [{ type: "text", text: "Tool arguments must be a JSON object." }],
        isError: true,
      };
    }

    try {
      return await this.handlers[name](args);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Tool ${name} failed: ${error.message ?? String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}

export { SUPPORTED_PROTOCOL_VERSIONS };
