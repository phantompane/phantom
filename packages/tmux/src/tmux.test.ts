import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import { isInsideTmux } from "./tmux.ts";

describe("tmux", () => {
  describe("isInsideTmux", () => {
    it("should return true when TMUX env var is set", async () => {
      const originalTmux = process.env.TMUX;
      process.env.TMUX = "/tmp/tmux-1000/default,12345,0";

      const result = await isInsideTmux();
      strictEqual(result, true);

      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
    });

    it("should return false when TMUX env var is not set", async () => {
      const originalTmux = process.env.TMUX;
      delete process.env.TMUX;

      const result = await isInsideTmux();
      strictEqual(result, false);

      if (originalTmux !== undefined) {
        process.env.TMUX = originalTmux;
      }
    });
  });
});
