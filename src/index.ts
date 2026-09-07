/**
 * Public surface of celeritty.
 *
 * Everything a consumer can import from the package root is re-exported here.
 * Deep imports into `src/` are not part of the contract and are not covered
 * by semver.
 */

export * from "./renderer/index";

export { Terminal } from "./core/terminal";
export type {
  CellPoint,
  LinkActivation,
  LinkModifiers,
  TerminalCursor,
  TerminalEvent,
  TerminalEventMap,
  TerminalFont,
  TerminalOptions,
  TerminalPalette,
} from "./core/types";

// Warm the wasm module ahead of constructing a terminal, and resolve an
// alacritty.toml in the browser — both documented in the README.
export { loadEngine } from "./core/wasm";
export { resolveAlacrittyToml } from "./core/config";

// A host rendering its own link overlay needs the same spans the terminal
// used; reimplementing the regex would drift.
export { findLinkAtColumn } from "./core/link-detection";
export type { DetectedLink } from "./core/link-detection";

// Type only: a value export from the root would pull the reference transport
// implementation into every consumer's bundle, including hosts that supply
// their own.
export type { TerminalTransport, TerminalOutputOptions } from "./transport/types";
export type { GridSize } from "./renderer/grid-metrics";
