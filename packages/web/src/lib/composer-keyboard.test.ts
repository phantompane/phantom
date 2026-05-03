import { describe, expect, it } from "vitest";
import { shouldSubmitComposerOnEnter } from "./composer-keyboard";

function createEnvironment(
  options: {
    coarsePointer?: boolean;
    finePointer?: boolean;
    hover?: boolean;
    maxTouchPoints?: number;
    mobileUserAgentData?: boolean;
    userAgent?: string;
    virtualKeyboardHeight?: number;
  } = {},
) {
  return {
    matchMedia: (query: string) => {
      const matches =
        (query === "(pointer: coarse)" && options.coarsePointer) ||
        (query === "(any-pointer: fine)" && options.finePointer) ||
        (query === "(hover: hover)" && options.hover);
      return { matches: Boolean(matches) };
    },
    navigator: {
      maxTouchPoints: options.maxTouchPoints ?? 0,
      userAgent: options.userAgent ?? "",
      userAgentData: {
        mobile: options.mobileUserAgentData ?? false,
      },
      virtualKeyboard: {
        boundingRect: {
          height: options.virtualKeyboardHeight ?? 0,
        },
      },
    },
  };
}

describe("shouldSubmitComposerOnEnter", () => {
  it("submits bare Enter from a hardware keyboard", () => {
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter" },
        createEnvironment(),
      ),
    ).toBe(true);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "NumpadEnter", key: "Enter" },
        createEnvironment(),
      ),
    ).toBe(true);
  });

  it("does not submit Enter without a hardware key code", () => {
    expect(
      shouldSubmitComposerOnEnter({ key: "Enter" }, createEnvironment()),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Unidentified", key: "Enter" },
        createEnvironment(),
      ),
    ).toBe(false);
  });

  it("does not submit modified Enter or IME composition", () => {
    const environment = createEnvironment();

    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter", shiftKey: true },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { altKey: true, code: "Enter", key: "Enter" },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", ctrlKey: true, key: "Enter" },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter", metaKey: true },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter", isComposing: true },
        environment,
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter", keyCode: 229 },
        environment,
      ),
    ).toBe(false);
  });

  it("does not submit while the VirtualKeyboard API reports an active software keyboard", () => {
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter" },
        createEnvironment({ virtualKeyboardHeight: 280 }),
      ),
    ).toBe(false);
  });

  it("does not submit Enter on Android Chrome software keyboard events", () => {
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter" },
        createEnvironment({
          maxTouchPoints: 5,
          userAgent:
            "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
        }),
      ),
    ).toBe(false);
  });

  it("does not submit Enter on coarse touch-only environments", () => {
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter" },
        createEnvironment({
          coarsePointer: true,
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(false);
  });
});
