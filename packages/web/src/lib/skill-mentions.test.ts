import { describe, expect, it } from "vitest";
import {
  completeSkillMention,
  filterSkillMentions,
  getMentionedSkillPaths,
  getSkillMentionKeyAction,
  getSkillMentionQuery,
  hasSkillMentionText,
  shouldOpenSkillMentionMenu,
} from "./skill-mentions";

const skills = [
  {
    description: "Create a pull request",
    displayName: "Create Pull Request",
    enabled: true,
    name: "create-pull-request",
    path: "/skills/create-pull-request/SKILL.md",
    shortDescription: "Open a PR",
  },
  {
    description: "Review changed code",
    displayName: "Review",
    enabled: true,
    name: "review",
    path: "/skills/review/SKILL.md",
    shortDescription: "Review changes",
  },
  {
    description: "Disabled skill",
    displayName: "Disabled",
    enabled: false,
    name: "disabled",
    path: "/skills/disabled/SKILL.md",
    shortDescription: null,
  },
];

describe("getSkillMentionQuery", () => {
  it("detects a skill mention after a delimiter", () => {
    expect(getSkillMentionQuery("$", 1)).toEqual({
      end: 1,
      query: "",
      start: 0,
    });
    expect(getSkillMentionQuery("Use $cre", 8)).toEqual({
      end: 8,
      query: "cre",
      start: 4,
    });
    expect(getSkillMentionQuery("Use\n$review", 11)).toEqual({
      end: 11,
      query: "review",
      start: 4,
    });
  });

  it("extends the replacement range through the current token", () => {
    expect(getSkillMentionQuery("Use $review later", 8)).toEqual({
      end: 11,
      query: "rev",
      start: 4,
    });
  });

  it("ignores mentions that are not separated before the marker", () => {
    expect(getSkillMentionQuery("Use$review", 10)).toBeNull();
  });

  it("requires ASCII whitespace before the marker", () => {
    expect(getSkillMentionQuery("Use　$review", 11)).toBeNull();
  });

  it("ignores mention queries with invalid characters", () => {
    expect(getSkillMentionQuery("Use $review:", 12)).toBeNull();
  });

  it("ignores mention tokens that are not separated after the name", () => {
    expect(getSkillMentionQuery("Use $review:", 8)).toBeNull();
  });
});

describe("filterSkillMentions", () => {
  it("returns enabled skills for an empty query", () => {
    expect(filterSkillMentions(skills, "").map((skill) => skill.name)).toEqual([
      "create-pull-request",
      "review",
    ]);
  });

  it("matches names and descriptions case-insensitively", () => {
    expect(
      filterSkillMentions(skills, "PR").map((skill) => skill.name),
    ).toEqual(["create-pull-request"]);
  });

  it("keeps only the first enabled skill for duplicate names", () => {
    expect(
      filterSkillMentions(
        [
          ...skills,
          {
            description: "Duplicate review skill",
            displayName: "Review Duplicate",
            enabled: true,
            name: "review",
            path: "/other/review/SKILL.md",
            shortDescription: null,
          },
        ],
        "review",
      ).map((skill) => skill.path),
    ).toEqual(["/skills/review/SKILL.md"]);
  });
});

describe("completeSkillMention", () => {
  it("replaces the active query and adds a trailing delimiter", () => {
    const mention = getSkillMentionQuery("Use $cre", 8);
    expect(mention).not.toBeNull();
    expect(completeSkillMention("Use $cre", mention!, skills[0]!)).toEqual({
      cursorPosition: 25,
      text: "Use $create-pull-request ",
    });
  });

  it("does not duplicate existing whitespace after the mention", () => {
    const mention = getSkillMentionQuery("Use $cre next", 8);
    expect(mention).not.toBeNull();
    expect(completeSkillMention("Use $cre next", mention!, skills[0]!)).toEqual(
      {
        cursorPosition: 25,
        text: "Use $create-pull-request next",
      },
    );
  });

  it("moves past an existing newline delimiter after completion", () => {
    const mention = getSkillMentionQuery("Use $cre\nnext", 8);
    expect(mention).not.toBeNull();
    expect(
      completeSkillMention("Use $cre\nnext", mention!, skills[0]!),
    ).toEqual({
      cursorPosition: 25,
      text: "Use $create-pull-request\nnext",
    });
  });

  it("replaces the entire mention token when the cursor is inside it", () => {
    const mention = getSkillMentionQuery("Use $review later", 8);
    expect(mention).not.toBeNull();
    expect(
      completeSkillMention("Use $review later", mention!, skills[0]!),
    ).toEqual({
      cursorPosition: 25,
      text: "Use $create-pull-request later",
    });
  });
});

describe("getMentionedSkillPaths", () => {
  it("returns enabled skills mentioned with delimiter boundaries", () => {
    expect(
      getMentionedSkillPaths(
        skills,
        "$create-pull-request and $review\nagain $review",
      ),
    ).toEqual([
      "/skills/create-pull-request/SKILL.md",
      "/skills/review/SKILL.md",
    ]);
  });

  it("ignores embedded, punctuated, unknown, and disabled mentions", () => {
    expect(
      getMentionedSkillPaths(skills, "pre$review $review. $unknown $disabled"),
    ).toEqual([]);
  });

  it("does not treat full-width spaces as mention boundaries", () => {
    expect(getMentionedSkillPaths(skills, "　$review $review　")).toEqual([]);
  });
});

describe("hasSkillMentionText", () => {
  it("detects mention text without requiring loaded skills", () => {
    expect(hasSkillMentionText("$review")).toBe(true);
    expect(hasSkillMentionText("Use $review\nnext")).toBe(true);
  });

  it("uses the same delimiter rules as skill path resolution", () => {
    expect(hasSkillMentionText("pre$review")).toBe(false);
    expect(hasSkillMentionText("$review:")).toBe(false);
    expect(hasSkillMentionText("　$review")).toBe(false);
  });

  it("is stable across repeated calls", () => {
    expect(hasSkillMentionText("$review")).toBe(true);
    expect(hasSkillMentionText("$review")).toBe(true);
  });
});

describe("getSkillMentionKeyAction", () => {
  it("maps plain navigation and completion keys when options are available", () => {
    expect(getSkillMentionKeyAction({ key: "ArrowDown" }, true)).toBe("next");
    expect(getSkillMentionKeyAction({ key: "ArrowUp" }, true)).toBe("previous");
    expect(getSkillMentionKeyAction({ key: "Home" }, true)).toBe("first");
    expect(getSkillMentionKeyAction({ key: "End" }, true)).toBe("last");
    expect(getSkillMentionKeyAction({ key: "Enter" }, true)).toBe("complete");
    expect(getSkillMentionKeyAction({ key: "Tab" }, true)).toBe("complete");
  });

  it("does not intercept IME composition or modified keys", () => {
    expect(
      getSkillMentionKeyAction({ isComposing: true, key: "Enter" }, true),
    ).toBeNull();
    expect(
      getSkillMentionKeyAction({ key: "Enter", keyCode: 229 }, true),
    ).toBeNull();
    expect(
      getSkillMentionKeyAction({ key: "Tab", shiftKey: true }, true),
    ).toBeNull();
  });

  it("only dismisses the menu when there are no options", () => {
    expect(getSkillMentionKeyAction({ key: "ArrowDown" }, false)).toBeNull();
    expect(getSkillMentionKeyAction({ key: "Enter" }, false)).toBeNull();
    expect(getSkillMentionKeyAction({ key: "Escape" }, false)).toBe("dismiss");
  });
});

describe("shouldOpenSkillMentionMenu", () => {
  const baseState = {
    composerText: "$",
    dismissedText: null,
    hasSelectedProject: true,
    isComposerBlocked: false,
    query: { end: 1, query: "", start: 0 },
  };

  it("opens for a skill mention in a selected project", () => {
    expect(shouldOpenSkillMentionMenu(baseState)).toBe(true);
  });

  it("stays closed when dismissed for the current text", () => {
    expect(
      shouldOpenSkillMentionMenu({
        ...baseState,
        dismissedText: "$",
      }),
    ).toBe(false);
  });
});
