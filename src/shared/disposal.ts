/** Best-effort teardown must not strand later resources when one hook throws. */
export function safely(cleanup: (() => void) | undefined): void {
  if (cleanup === undefined) return;
  try {
    cleanup();
  } catch {
    // Disposal is terminal and idempotent; there is no useful recovery here.
  }
}
