import { describe, expect, it } from "vitest";
import {
  getComposerEnterAction,
  getComposerSubmitModeForEnter,
  shouldSubmitComposerOnEnter,
} from "./composer-keyboard";

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
      getComposerEnterAction(
        { code: "Enter", key: "Enter" },
        createEnvironment(),
      ),
    ).toBe("submit");
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

  it("returns a modified submit action for Command or Ctrl Enter", () => {
    expect(
      getComposerEnterAction(
        { code: "Enter", key: "Enter", metaKey: true },
        createEnvironment(),
      ),
    ).toBe("modifiedSubmit");
    expect(
      getComposerEnterAction(
        { code: "Enter", ctrlKey: true, key: "Enter" },
        createEnvironment(),
      ),
    ).toBe("modifiedSubmit");
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", key: "Enter", metaKey: true },
        createEnvironment(),
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter(
        { code: "Enter", ctrlKey: true, key: "Enter" },
        createEnvironment(),
      ),
    ).toBe(false);
  });

  it("does not submit Enter without a hardware key code", () => {
    expect(getComposerEnterAction({ key: "Enter" }, createEnvironment())).toBe(
      null,
    );
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

describe("getComposerSubmitModeForEnter", () => {
  it("sends bare Enter when the chat has no active turn", () => {
    expect(getComposerSubmitModeForEnter("submit", null)).toBe("send");
    expect(
      getComposerSubmitModeForEnter("submit", {
        activeTurnId: null,
        status: "idle",
      }),
    ).toBe("send");
  });

  it("queues modified Enter regardless of local active turn state", () => {
    expect(getComposerSubmitModeForEnter("modifiedSubmit", null)).toBe("queue");
    expect(
      getComposerSubmitModeForEnter("modifiedSubmit", {
        activeTurnId: null,
        status: "idle",
      }),
    ).toBe("queue");
  });

  it("steers bare Enter only while the active chat is running", () => {
    expect(
      getComposerSubmitModeForEnter("submit", {
        activeTurnId: "turn_1",
        status: "running",
      }),
    ).toBe("steer");
    expect(
      getComposerSubmitModeForEnter("submit", {
        activeTurnId: "turn_1",
        status: "waitingForApproval",
      }),
    ).toBe(null);
  });

  it("queues Command Enter while the chat has an active turn", () => {
    expect(
      getComposerSubmitModeForEnter("modifiedSubmit", {
        activeTurnId: "turn_1",
        status: "running",
      }),
    ).toBe("queue");
    expect(
      getComposerSubmitModeForEnter("modifiedSubmit", {
        activeTurnId: "turn_1",
        status: "waitingForApproval",
      }),
    ).toBe("queue");
  });
});
