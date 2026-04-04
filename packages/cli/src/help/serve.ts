import type { CommandHelp } from "../help.ts";

export const serveHelp: CommandHelp = {
  name: "serve",
  description: "Start the experimental standalone Phantom server",
  usage: "phantom serve [options]",
  options: [
    {
      name: "help",
      short: "h",
      type: "boolean",
      description: "Show help message",
    },
  ],
  examples: [
    {
      description: "Start the experimental standalone server",
      command: "phantom serve",
    },
  ],
  notes: [
    "This command is experimental and may change without notice.",
    "By default, the standalone server listens on port 9640.",
    "This command imports the server entrypoint generated under packages/server/dist/server.js.",
  ],
};
