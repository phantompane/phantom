export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  if (!globalThis.isSecureContext) {
    return;
  }

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
