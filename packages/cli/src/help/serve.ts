import type { CommandHelp } from "../help.ts";

export const serveHelp: CommandHelp = {
  name: "serve",
  description:
    "Start the experimental Phantom GUI and Hono RPC backend on port 9640",
  usage: "phantom serve",
  examples: [
    {
      description: "Launch the experimental local web UI",
      command: "phantom serve",
    },
  ],
  notes: [
    "This command is experimental.",
    "It serves the bundled GUI and backend from a single process on port 9640.",
  ],
};
