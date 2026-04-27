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
  navigator?: {
    maxTouchPoints?: number;
    virtualKeyboard?: {
      boundingRect?: {
        height?: number;
      };
    };
  };
};

export function shouldSubmitComposerOnEnter(
  event: ComposerEnterKeyEvent,
  environment: ComposerEnterKeyEnvironment = globalThis,
): boolean {
  const isImeComposing = event.isComposing || event.keyCode === 229;
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isImeComposing
  ) {
    return false;
  }

  return (
    isHardwareEnterKey(event) && !isKnownSoftwareKeyboardActive(environment)
  );
}

function isHardwareEnterKey(event: ComposerEnterKeyEvent): boolean {
  return event.code === "Enter" || event.code === "NumpadEnter";
}

function isKnownSoftwareKeyboardActive(
  environment: ComposerEnterKeyEnvironment,
): boolean {
  const virtualKeyboardHeight =
    environment.navigator?.virtualKeyboard?.boundingRect?.height ?? 0;
  return virtualKeyboardHeight > 0;
}
