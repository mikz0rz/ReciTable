# Changelog

Versions follow [semver](https://semver.org): breaking the recipe-JSON format or
the renderer's markup bumps major, features bump minor, fixes bump patch. Each
release is tagged in git (`v0.2.0`) so `git diff v0.1.0..v0.2.0` shows exactly
what moved, and `git checkout v0.1.0` gets the old state back.

## 0.3.1 — 2026-10-05

- The misplaced-ingredient smell from 0.3.0 was too easy to satisfy. On a re-run
  of the same soup the broth came back inside `bake` — a child of the transfer's
  own child — so it was still "beneath" the cell whose detail says "along with
  the broth", and the guard stayed quiet on the same defect it was written for.
  A detail that *adds* an ingredient ("along with", "stir in", "pour in") now
  demands it as a **direct child**; only a detail that merely refers to one
  ("until the potatoes are tender") is satisfied by it lying anywhere beneath.
  Prompt-only rules were not enough — the model kept finding the deeper shape.

## 0.3.0 — 2026-10-05

- An ingredient is sequenced into the operation whose detail adds it. The Boursin
  butternut squash soup came back as one chain with the broth written as a child
  of a detail-less `stir` — after `simmer` — while the transfer cell's own detail
  said "along with the broth". The model had also filed the source's "prep the veg
  and add them to the dish" under `prep`, so every ingredient landed in the `bake`
  cell and the toss and nestle steps vanished. Two prompt rules close that: `prep`
  holds only steps that add no ingredient — however the source words an
  ingredient-adding step, it is an operation — and an ingredient belongs inside the
  operation whose detail names it, not the one that merely ends up containing it.
- A second shape smell, alongside the flattened-fan one: an operation whose detail
  names an ingredient lying outside its own subtree — the table contradicting its
  own text. The fan smell never fires on a chain, so this one catches a misplaced
  leaf. It rides the same one-round reconsideration, which stays non-fatal.

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
