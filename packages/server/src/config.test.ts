import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.ts";
import packageJson from "../package.json" with { type: "json" };

describe("server package configuration", () => {
  it("uses the private workspace package name", () => {
    expect(packageJson.name).toBe("@phantompane/server-private");
  });

  it("enables standalone output", () => {
    expect(nextConfig.output).toBe("standalone");
  });
});
