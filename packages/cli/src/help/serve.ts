import type { CommandHelp } from "../help.ts";

export const serveHelp: CommandHelp = {
  name: "serve",
  description: "Start the standalone Phantom server",
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
      description: "Start the standalone server",
      command: "phantom serve",
    },
  ],
  notes: [
    "By default, the standalone server listens on port 9640.",
    "This command imports the standalone Next.js server entrypoint generated under packages/server/dist/server.js.",
  ],
};
