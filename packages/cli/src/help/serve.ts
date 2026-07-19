import type { CommandHelp } from "../help.ts";

export const serveHelp: CommandHelp = {
  name: "serve",
  description: "Start the experimental Phantom API server",
  usage: "phantom serve [options]",
  options: [
    {
      name: "help",
      short: "h",
      type: "boolean",
      description: "Show help message",
    },
    {
      name: "host",
      type: "string",
      description: "Host interface to bind the server to",
      example: "--host 0.0.0.0",
    },
    {
      name: "port",
      type: "string",
      description: "Port to bind the server to",
      example: "--port 4000",
    },
    {
      name: "codex-bin",
      type: "string",
      description: "Codex executable to use for the App Server backend",
      example: "--codex-bin /usr/local/bin/codex",
    },
    {
      name: "data-dir",
      type: "string",
      description: "Directory for Phantom serve state",
      example: "--data-dir ~/.local/state/phantom",
    },
    {
      name: "open",
      type: "boolean",
      description: "Open phantompane.dev in the default browser",
    },
  ],
  examples: [
    {
      description: "Start the API server on the default port 9640",
      command: "phantom serve",
    },
    {
      description: "Bind the API server to all interfaces on port 4000",
      command: "phantom serve --host 0.0.0.0 --port 4000",
    },
  ],
  notes: [
    "Experimental: this command and its runtime behavior may change without notice.",
    "The server runs the Phantom API. Use the Web UI at https://phantompane.dev.",
    "The default host is 127.0.0.1.",
    "The default port is 9640.",
    "The Codex executable defaults to codex.",
    "The bundled server assets must exist under packages/cli/dist/app/server.",
    "Set PHANTOM_SERVE_ALLOWED_ORIGINS to a comma-separated list when hosting the Web UI on additional origins.",
    "Use HTTPS for non-loopback connections from phantompane.dev; browsers may block plain HTTP LAN endpoints.",
    "The underlying Hono server respects HOST/PORT.",
  ],
};
