import { describe, expect, it } from "vitest";
import {
  completeSlashCommand,
  filterSlashCommands,
  getSlashCommandKeyAction,
  getSlashCommandQuery,
  shouldOpenSlashCommandMenu,
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

  it("does not advertise commands that require unimplemented web handling", () => {
    expect(slashCommandOptions.map((command) => command.command)).not.toContain(
      "/clear",
    );
  });
});

describe("completeSlashCommand", () => {
  it("adds a trailing space so the user can continue typing", () => {
    expect(completeSlashCommand(slashCommandOptions[0])).toBe("/plan ");
  });
});

describe("getSlashCommandKeyAction", () => {
  it("maps plain navigation and completion keys when options are available", () => {
    expect(getSlashCommandKeyAction({ key: "ArrowDown" }, true)).toBe("next");
    expect(getSlashCommandKeyAction({ key: "ArrowUp" }, true)).toBe("previous");
    expect(getSlashCommandKeyAction({ key: "Home" }, true)).toBe("first");
    expect(getSlashCommandKeyAction({ key: "End" }, true)).toBe("last");
    expect(getSlashCommandKeyAction({ key: "Enter" }, true)).toBe("complete");
    expect(getSlashCommandKeyAction({ key: "Tab" }, true)).toBe("complete");
  });

  it("does not intercept IME composition keys", () => {
    expect(
      getSlashCommandKeyAction({ isComposing: true, key: "Enter" }, true),
    ).toBeNull();
    expect(
      getSlashCommandKeyAction({ key: "Enter", keyCode: 229 }, true),
    ).toBeNull();
  });

  it("does not trap modified keys that should keep native textarea behavior", () => {
    expect(
      getSlashCommandKeyAction({ key: "Tab", shiftKey: true }, true),
    ).toBeNull();
    expect(
      getSlashCommandKeyAction({ key: "Enter", metaKey: true }, true),
    ).toBeNull();
    expect(
      getSlashCommandKeyAction({ key: "ArrowDown", shiftKey: true }, true),
    ).toBeNull();
  });

  it("only dismisses the menu when there are no options", () => {
    expect(getSlashCommandKeyAction({ key: "ArrowDown" }, false)).toBeNull();
    expect(getSlashCommandKeyAction({ key: "Enter" }, false)).toBeNull();
    expect(getSlashCommandKeyAction({ key: "Escape" }, false)).toBe("dismiss");
  });
});

describe("shouldOpenSlashCommandMenu", () => {
  const baseState = {
    composerText: "/",
    dismissedText: null,
    hasSelectedChat: true,
    hasSelectedProject: true,
    isComposerBlocked: false,
    query: "",
  };

  it("opens for slash input in an existing chat", () => {
    expect(shouldOpenSlashCommandMenu(baseState)).toBe(true);
  });

  it("stays closed before a chat exists", () => {
    expect(
      shouldOpenSlashCommandMenu({
        ...baseState,
        hasSelectedChat: false,
      }),
    ).toBe(false);
  });

  it("stays closed when dismissed for the current text", () => {
    expect(
      shouldOpenSlashCommandMenu({
        ...baseState,
        dismissedText: "/",
      }),
    ).toBe(false);
  });
});
