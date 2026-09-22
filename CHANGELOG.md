# Changelog

Versions follow [semver](https://semver.org): breaking the recipe-JSON format or
the renderer's markup bumps major, features bump minor, fixes bump patch. Each
release is tagged in git (`v0.2.0`) so `git diff v0.1.0..v0.2.0` shows exactly
what moved, and `git checkout v0.1.0` gets the old state back.

## 0.2.1 — 2026-09-22

- Branch order in the tree is now cooking order. Rule 7 said "put the base
  first", which for anything seared and set aside before a sauce is built wrote
  the sauce branch first — the mango chicken came out with `season`/`sear` as
  stages 5 and 6, after "add the mango and stock", so cook mode told the cook to
  add the mango before the chicken was seared. Children are now listed in the
  order the source performs them; "base first" survives only as a tiebreak for
  children the source doesn't order. The fork itself is unchanged — the seared
  chicken is still a branch of "return", written first now instead of last.

## 0.2.0 — 2026-09-05

- Nexos is the predefined provider, first in line: OpenAI-compatible at
  `https://api.nexos.ai/v1`, keys generated at workspace.nexos.ai.
- Ingredient coverage check: when the page has structured data, the run diffs
  the source's ingredient list against the model's tree and asks once for
  anything silently dropped (the shorabet adas onion). A shape reconsideration
  can no longer drop coverage; an uncovered gap is named in the run log.
- The run log's structure check counts ingredients by walking the tree — the
  old line read a field sections never have and always reported 0.

## 0.1.0 — 2026-07-29

- First working version: the nested-table renderer (Python CLI and Chrome
  extension, byte-identical), the tree-shaped model contract with salvage,
  validation, repair and simple mode, two provider protocols with degradation
  ladders, and the ASCII kitchen.
