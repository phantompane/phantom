import { describe, expect, it } from "vitest";

describe("gui package", () => {
  it("keeps the expected package name", async () => {
    const packageJson = await import("../package.json", {
      with: { type: "json" },
    });

    expect(packageJson.default.name).toBe("@phantompane/gui");
  });
});
