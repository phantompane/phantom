import { describe, expect, it } from "vitest";
import {
  getRecentProjectSkillRecords,
  rememberRecentProjectSkillSelection,
} from "./recent-project-skills.ts";

describe("rememberRecentProjectSkillSelection", () => {
  it("keeps the most recently selected skill first for a project", () => {
    expect(
      rememberRecentProjectSkillSelection(
        {
          "project-1": [
            {
              path: "/skills/review/SKILL.md",
              lastUsedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
        },
        "project-1",
        "/skills/test/SKILL.md",
        "2026-05-08T01:00:00.000Z",
      ),
    ).toEqual({
      "project-1": [
        {
          path: "/skills/test/SKILL.md",
          lastUsedAt: "2026-05-08T01:00:00.000Z",
        },
        {
          path: "/skills/review/SKILL.md",
          lastUsedAt: "2026-05-08T00:00:00.000Z",
        },
      ],
    });
  });

  it("updates an existing skill instead of duplicating it", () => {
    expect(
      rememberRecentProjectSkillSelection(
        {
          "project-1": [
            {
              path: "/skills/review/SKILL.md",
              lastUsedAt: "2026-05-08T00:00:00.000Z",
            },
            {
              path: "/skills/test/SKILL.md",
              lastUsedAt: "2026-05-08T00:30:00.000Z",
            },
          ],
        },
        "project-1",
        "/skills/review/SKILL.md",
        "2026-05-08T01:00:00.000Z",
      ),
    ).toEqual({
      "project-1": [
        {
          path: "/skills/review/SKILL.md",
          lastUsedAt: "2026-05-08T01:00:00.000Z",
        },
        {
          path: "/skills/test/SKILL.md",
          lastUsedAt: "2026-05-08T00:30:00.000Z",
        },
      ],
    });
  });

  it("limits records per project without touching other projects", () => {
    expect(
      rememberRecentProjectSkillSelection(
        {
          "project-1": [
            {
              path: "/skills/a/SKILL.md",
              lastUsedAt: "2026-05-08T00:04:00.000Z",
            },
            {
              path: "/skills/b/SKILL.md",
              lastUsedAt: "2026-05-08T00:03:00.000Z",
            },
          ],
          "project-2": [
            {
              path: "/skills/other/SKILL.md",
              lastUsedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
        },
        "project-1",
        "/skills/c/SKILL.md",
        "2026-05-08T00:05:00.000Z",
        2,
      ),
    ).toEqual({
      "project-1": [
        {
          path: "/skills/c/SKILL.md",
          lastUsedAt: "2026-05-08T00:05:00.000Z",
        },
        {
          path: "/skills/a/SKILL.md",
          lastUsedAt: "2026-05-08T00:04:00.000Z",
        },
      ],
      "project-2": [
        {
          path: "/skills/other/SKILL.md",
          lastUsedAt: "2026-05-08T00:00:00.000Z",
        },
      ],
    });
  });
});

describe("getRecentProjectSkillRecords", () => {
  it("returns records for the selected project only", () => {
    expect(
      getRecentProjectSkillRecords(
        {
          "project-1": [
            {
              path: "/skills/review/SKILL.md",
              lastUsedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
          "project-2": [
            {
              path: "/skills/test/SKILL.md",
              lastUsedAt: "2026-05-08T01:00:00.000Z",
            },
          ],
        },
        "project-1",
      ),
    ).toEqual([
      {
        path: "/skills/review/SKILL.md",
        lastUsedAt: "2026-05-08T00:00:00.000Z",
      },
    ]);
  });
});
