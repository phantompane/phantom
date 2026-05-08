type ComposerEnterKeyEvent = {
  altKey?: boolean;
  code?: string;
  ctrlKey?: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey?: boolean;
  shiftKey?: boolean;
};

type ComposerEnterKeyEnvironment = {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: {
    maxTouchPoints?: number;
    userAgent?: string;
    userAgentData?: {
      mobile?: boolean;
    };
    virtualKeyboard?: {
      boundingRect?: {
        height?: number;
      };
    };
  };
};

export type ComposerEnterAction = "modifiedSubmit" | "submit";
export type ComposerSubmitMode = "queue" | "send" | "steer";

type ComposerChatState = {
  activeTurnId?: string | null;
  status?: string | null;
};

export function shouldSubmitComposerOnEnter(
  event: ComposerEnterKeyEvent,
  environment: ComposerEnterKeyEnvironment = globalThis,
): boolean {
  return getComposerEnterAction(event, environment) === "submit";
}

export function getComposerEnterAction(
  event: ComposerEnterKeyEvent,
  environment: ComposerEnterKeyEnvironment = globalThis,
): ComposerEnterAction | null {
  const isImeComposing = event.isComposing || event.keyCode === 229;
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    isImeComposing
  ) {
    return null;
  }

  if (
    !isHardwareEnterKey(event) ||
    isLikelyMobileTextEntryEnvironment(environment)
  ) {
    return null;
  }

  return event.metaKey || event.ctrlKey ? "modifiedSubmit" : "submit";
}

export function getComposerSubmitModeForEnter(
  action: ComposerEnterAction,
  chat: ComposerChatState | null | undefined,
): ComposerSubmitMode | null {
  if (action === "modifiedSubmit") {
    return "queue";
  }

  if (!chat?.activeTurnId) {
    return "send";
  }

  return chat.status === "running" ? "steer" : null;
}

function isHardwareEnterKey(event: ComposerEnterKeyEvent): boolean {
  return event.code === "Enter" || event.code === "NumpadEnter";
}

function isLikelyMobileTextEntryEnvironment(
  environment: ComposerEnterKeyEnvironment,
): boolean {
  const virtualKeyboardHeight =
    environment.navigator?.virtualKeyboard?.boundingRect?.height ?? 0;
  if (virtualKeyboardHeight > 0) {
    return true;
  }

  if (environment.navigator?.userAgentData?.mobile) {
    return true;
  }

  const userAgent = environment.navigator?.userAgent ?? "";
  if (/(Android|iPhone|iPad|iPod|Mobile|Windows Phone)/i.test(userAgent)) {
    return true;
  }

  const maxTouchPoints = environment.navigator?.maxTouchPoints ?? 0;
  if (maxTouchPoints === 0 || !environment.matchMedia) {
    return false;
  }

  const hasCoarsePrimaryPointer =
    environment.matchMedia("(pointer: coarse)").matches;
  const hasFinePointer = environment.matchMedia("(any-pointer: fine)").matches;
  const hasHover = environment.matchMedia("(hover: hover)").matches;

  return hasCoarsePrimaryPointer && !hasFinePointer && !hasHover;
}
