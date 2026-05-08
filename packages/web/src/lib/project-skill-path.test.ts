import { describe, expect, it } from "vitest";
import { getProjectSkillPathIdentity } from "./project-skill-path";

describe("getProjectSkillPathIdentity", () => {
  it("normalizes project-local skill paths relative to the active root", () => {
    expect(
      getProjectSkillPathIdentity(
        "/repo/.git/phantom/worktrees/feature/.codex/skills/review/SKILL.md",
        ["/repo", "/repo/.git/phantom/worktrees/feature"],
      ),
    ).toBe(".codex/skills/review/SKILL.md");
  });

  it("leaves external skill paths stable", () => {
    expect(
      getProjectSkillPathIdentity("/home/user/.codex/skills/review/SKILL.md", [
        "/repo",
      ]),
    ).toBe("/home/user/.codex/skills/review/SKILL.md");
  });
});
