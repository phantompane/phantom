import { describe, expect, it } from "vitest";
import { RESIZABLE_HANDLE_CLASS_NAME } from "./resizable";

describe("resizable handle styles", () => {
  it("keeps horizontal panel group separators vertical", () => {
    expect(RESIZABLE_HANDLE_CLASS_NAME).toContain("w-px");
    expect(RESIZABLE_HANDLE_CLASS_NAME).toContain(
      "[aria-orientation=horizontal]:h-px",
    );
    expect(RESIZABLE_HANDLE_CLASS_NAME).not.toContain(
      "[aria-orientation=vertical]:h-px",
    );
  });
});
