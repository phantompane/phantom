import type { CommandHelp } from "../help.ts";

export const serveHelp: CommandHelp = {
  name: "serve",
  description: "Start the experimental bundled Phantom web server",
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
      description: "Open the web interface in the default browser",
    },
  ],
  examples: [
    {
      description: "Start the bundled server on the default port 9640",
      command: "phantom serve",
    },
    {
      description: "Bind the bundled server to all interfaces on port 4000",
      command: "phantom serve --host 0.0.0.0 --port 4000",
    },
  ],
  notes: [
    "Experimental: this command and its runtime behavior may change without notice.",
    "The server runs the bundled TanStack Start application shipped with Phantom.",
    "The default host is 127.0.0.1.",
    "The default port is 9640.",
    "The Codex executable defaults to codex.",
    "The bundled app assets must exist under packages/cli/dist/app/.output.",
    "The underlying Nitro server also respects HOST/PORT and NITRO_HOST/NITRO_PORT.",
  ],
};
