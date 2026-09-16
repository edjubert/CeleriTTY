# Changelog

## Unreleased — proposed 1.3.0

### Changed

- Selection coordinates are clamped to the viewport before conversion to
  scrollback coordinates. Reversed corners are normalized and return selected
  text instead of the empty string returned by the low-level WASM binding in
  1.2.0. The high-level `Terminal.getSelection()` already normalizes corners.
  Consumers of the low-level binding that used reversed corners to mean
  “no selection” must check their selection state explicitly instead.
- Target a minor release for this intentional selection behavior change;
  package versions remain unchanged until the maintainer cuts the release.

### Fixed

- Out-of-grid selections and wide-character wrap selection cannot read a
  nonexistent neighbouring row, including with a restricted scroll region.
