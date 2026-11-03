/**
 * Keeps the tab alive while a long upload runs. Chrome does not freeze a tab
 * that holds a Web Lock, and a `beforeunload` prompt discourages closing or
 * discarding it by accident. Returns a release function (idempotent).
 */
export function holdUploadGuard(id: string): () => void {
  let released = false;
  let releaseLock: (() => void) | null = null;

  try {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      void navigator.locks
        .request(
          `padmakara-video-upload-${id}`,
          () =>
            new Promise<void>((resolve) => {
              releaseLock = resolve;
              // Released before the lock was granted: let go immediately.
              if (released) resolve();
            }),
        )
        .catch(() => {});
    }
  } catch {
    // Web Locks unavailable or blocked: the beforeunload guard still applies.
  }

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    if (released) return;
    released = true;
    releaseLock?.();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", onBeforeUnload);
  };
}
