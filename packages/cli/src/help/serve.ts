import type { CommandHelp } from "../help.ts";

export const serveHelp: CommandHelp = {
  name: "serve",
  description: "Start the bundled Phantom web server",
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
    "The server runs the bundled TanStack Start application shipped with Phantom.",
    "The default port is 9640.",
    "Build the CLI first so packages/cli/dist/app/.output is available.",
    "The underlying Nitro server also respects HOST/PORT and NITRO_HOST/NITRO_PORT.",
  ],
};
