/**
 * How a terminal talks to whatever is running the shell.
 *
 * Four methods, deliberately. A real host needs far more — reattaching to a
 * session by id, an exit code, replaying scrollback after a reconnect,
 * recovering from a stalled socket. All of that belongs *above* this
 * interface, in the host's own implementation, where it stays invisible to
 * the component. That is what keeps one embedder's protocol out of everyone
 * else's package.
 */
export interface TerminalTransport {
  /** Send input and parser-generated protocol replies to the process. */
  write(bytes: Uint8Array): void;

  /** Tell the process the grid changed size. */
  resize(columns: number, rows: number): void;

  /**
   * Subscribe to process output. Returns an unsubscribe function; the
   * terminal calls it on `detach` and on `dispose`, so an implementation that
   * ignores the return value will leak listeners across reconnects.
   */
  onData(cb: (bytes: Uint8Array) => void): () => void;

  /**
   * Subscribe to the connection ending, for any reason. `reason` is a
   * human-readable message when there is one. Returns an unsubscribe
   * function.
   */
  onClose(cb: (reason?: string) => void): () => void;
}
