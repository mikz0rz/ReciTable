# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ReciTable renders a recipe as a nested table in the Cooking for Engineers format:
ingredients are rows down the left, and each operation is a cell spanning exactly
the rows it consumes. Two front ends share one renderer — a Chrome extension that
converts the page you are reading, and `render_recipe.py` for a recipe JSON on disk.

## Commands

```bash
python3 tests/parity.py                              # Python and JS renderers agree byte-for-byte
node tests/pipeline.mjs                              # model output -> validation -> tree -> markup
node tests/providers.mjs                             # streaming, fallback ladders, failure paths
python3 render_recipe.py recipes/foo.json            # -> recipes/foo.html (regenerates; .html is gitignored)
python3 extension/icons/make_icons.py                # regenerate toolbar icons
```

No build step, no package.json, no dependencies. The extension loads unpacked from
`extension/` as-is — **do not introduce a bundler**, it would remove that property.

The suites are plain scripts, not a framework: there is no filtering, so the unit of
execution is the whole file. Each prints `ok`/`FAIL` per assertion and exits non-zero
on failure. In the two `.mjs` suites, add one by calling
`check(name, condition, detail)`; `parity.py` instead iterates `recipes/*.json`, so a
new recipe file is automatically covered.

### Verifying visual output

The layout is visual, so screenshot it and look rather than trusting the markup:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --hide-scrollbars --virtual-time-budget=3000 \
  --screenshot=<scratchpad>/out.png --window-size=1000,900 \
  "file://$PWD/recipes/espresso-brownies.html"
```

Then Read the PNG. To drive the interactive layer, copy the HTML to the scratchpad
and append a `<script>` that clicks things (the inlined script has already run by
then). To check print CSS, extract the `@media print` block and re-apply it
unconditionally at page width — headless screenshots do not emulate print media.
`chrome --pack-extension=<abs path>/extension` validates the manifest.

## Architecture

### The renderer is duplicated on purpose, and parity is enforced

`render_recipe.py` (CLI) and `extension/shared/layout.js` (browser) implement the
same layout and **must emit byte-identical markup**. `tests/parity.py` renders every
recipe in `recipes/` through both and diffs. Change one, change the other, run it.

Consequences worth knowing before editing either:

- Number formatting is deliberately matched (`num`/`pct` in Python, the same in JS),
  because `String(2)` and `f"{2:g}"` have to agree.
- Attribute order in emitted tags is fixed. Reordering breaks parity, not rendering.
- `article_html()` (Python) and `renderArticle()` (JS) are the compared surfaces;
  both mutate the tree with layout bookkeeping, so callers pass a private copy.

`extension/shared/recipe-table.css` is the single stylesheet — **Python reads it from
`extension/shared/` at runtime** (`CSS_PATH` in `render_recipe.py`), so style-only
changes need no port. Same for `interactive.js`, which Python inlines verbatim.

### The model returns the tree, spelled out to a fixed depth

`extension/shared/schema.js` owns the contract. JSON Schema cannot express recursion,
so `operation(depth)` writes the tree out level by level (`MAX_DEPTH` levels, ~7 kB of
schema; nested levels drop their field descriptions to keep that down).

An earlier version asked for a **flat graph of ids** instead and assembled the tree
here. Don't go back to it: a graph lets the model emit shapes that are not trees (an
id consumed twice, a cycle, a dangling reference), it did so repeatedly on real
recipes, and no prompt or repair round fixed it. With no ids, those failures cannot be
expressed. `validateRecipe()` is now only about emptiness and half-given quantities,
and `buildTree()` only strips the empty strings the schema forces.

Validation failures are still fed back once as a repair prompt, so **error strings are
prompts** — they must name what is wrong and state the remedy. `tests/pipeline.mjs`
asserts that wording.

A recipe JSON on disk is the *tree* shape. Its schema and the rules for building one
are documented in `.claude/skills/recipe-table/SKILL.md`; don't duplicate them here.

### Post-order traversal is the cooking sequence

The tree's post-order is the order a cook works in (whisk dry → beat eggs → combine →
heat milk → stir in fats → add to batter → bake). Both renderers stamp each operation
with `data-stage` from that traversal, plus `data-rows` for the leaves it consumes, and
`data-amount`/`data-metric` where the source stated quantities.

`extension/shared/interactive.js` reads only those attributes to add cook mode, stage
timers, rescaling and cross-off. It therefore has two hard constraints:

- **No imports or exports** — `render_recipe.py` inlines it into standalone HTML.
- **Controls are built by the script, never emitted by the renderers**, so a page with
  JS disabled shows a clean table instead of dead buttons.

Its pure helpers are exposed on `globalThis.__reciTableInternals` as a testing seam
(fraction rounding, metric rounding, duration parsing from prose), asserted in
`tests/pipeline.mjs`. The seam is set before the `document.querySelector` guard so it
works with no DOM.

### The extension: one run log, three views

`extension/background.js` owns a conversion and writes every step to
`chrome.storage.session` under `run`. The dropdown (`popup.js`), the run's own tab
(`viewer.js`) and the toolbar badge all render that one record and hold no state, so
closing and reopening any of them shows the truth — including a failure that happened
while it was shut. `shared/runlog.js` renders the step list for both HTML views.

Points that are easy to get wrong here:

- Chrome closes a popup whenever it loses focus and offers no way to prevent it. The
  background tab (opened **unfocused**, beside the source page) and the badge are what
  carry a long run. Do not try to keep the popup alive.
- MV3 kills an idle service worker in ~30s, which would silently abandon a slow
  request; `keepAwake()` pings an API on an interval while a run is active, and
  `reconcile()` runs at module scope so a worker restart marks the lost run instead of
  leaving it "running" forever.
- `publish()` chains storage writes, because each `set()` serialises a snapshot and
  out-of-order writes would show state that has already moved on.

### Providers: two protocols, two degradation ladders

`extension/shared/providers.js` speaks OpenAI-compatible `/chat/completions`
(OpenRouter, OpenAI, local servers) and Anthropic `/v1/messages`. `complete()` walks
two ladders and reports which rungs worked so the caller can cache them:

- structured output: strict `json_schema` → `json_object` → prompt-only
- streaming on → off, for endpoints that reject it

Streaming exists so a slow model is distinguishable from a wedged one, and so the
stall deadline is meaningful. `DEADLINES` (`stall`, `total`) is a mutable export that
tests shorten. Deadlines are enforced two ways — aborting the request *and* racing
every read against a rejection promise — because a body that ignores its signal would
otherwise hang forever. That silent hang was a real bug; `tests/providers.mjs` covers
it with a stream that opens and says nothing.

No test covers a live provider call. `tests/providers.mjs` stubs `fetch`.

## Conventions that matter here

- Quantities are never converted, rounded or invented. `item` holds the source's text
  verbatim and is what is displayed; the parsed `amount`/`metric` fields exist only so
  the page can rescale, and a metric figure is carried only if the source printed one.
- Scaling adjusts amounts only. Times, pan sizes and oven temperatures do not scale,
  and a scaled yield is marked "× 2" rather than left claiming the original.
- Model output is never trusted on shape. A malformed graph produces a stated error,
  never a silently wrong table.

### The ASCII kitchen

`extension/shared/kitchen.js` animates the waiting tab. The scene is picked from the
running step's words, so it illustrates rather than decorates; the model call matches
nothing on purpose, so a long wait rotates dishes. Every frame of every scene must be
the same box — `normalise()` pads them and `tests/pipeline.mjs` asserts it, otherwise
the art jitters as frames swap.
