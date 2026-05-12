import { describe, expect, it } from "vitest";
import {
  completeSlashCommand,
  filterSlashCommands,
  getSlashCommandQuery,
  slashCommandOptions,
} from "./slash-commands";

describe("getSlashCommandQuery", () => {
  it("detects command text at the start of the composer", () => {
    expect(getSlashCommandQuery("/")).toBe("");
    expect(getSlashCommandQuery("/pla")).toBe("pla");
  });

  it("closes command search after whitespace or non-command text", () => {
    expect(getSlashCommandQuery(" /plan")).toBeNull();
    expect(getSlashCommandQuery("/plan ")).toBeNull();
    expect(getSlashCommandQuery("/plan\nnext")).toBeNull();
    expect(getSlashCommandQuery("please /plan")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("returns all commands for an empty query", () => {
    expect(filterSlashCommands(slashCommandOptions, "")).toEqual(
      slashCommandOptions,
    );
  });

  it("matches command names and keywords case-insensitively", () => {
    expect(
      filterSlashCommands(slashCommandOptions, "PLA").map(
        (command) => command.command,
      ),
    ).toContain("/plan");
    expect(
      filterSlashCommands(slashCommandOptions, "tokens").map(
        (command) => command.command,
      ),
    ).toContain("/status");
  });
});

describe("completeSlashCommand", () => {
  it("adds a trailing space so the user can continue typing", () => {
    expect(completeSlashCommand(slashCommandOptions[0])).toBe("/plan ");
  });
});
