---
name: recipe-table
description: Turn a recipe link (or pasted recipe text) into a Cooking-for-Engineers style nested recipe table — ingredients down the left, operations bracketing them to the right. Use whenever the user drops a recipe URL, pastes a recipe, or asks to convert/redraw a recipe in the table, grid, schematic, or bracket format.
---

# Recipe table

Convert a recipe into a nested table: ingredients are rows on the left, each
operation is a cell to the right spanning the rows it consumes, so the whole
method reads as one flow diagram. Output is JSON in `recipes/`, rendered to HTML
by `render_recipe.py`.

Never hand-write the HTML. The rowspan/colspan layout is computed by the script.

## Steps

1. **Get the source.** WebFetch the URL with a prompt asking for: the full
   ingredient list with exact quantities (both volume and metric where given),
   pan/vessel size, oven temperature, bake or cook time, yield, and the
   instruction steps verbatim. If the fetch is blocked (some recipe sites refuse),
   say so and ask the user to paste the text — don't reconstruct the recipe from
   memory, and don't substitute a different recipe.
2. **Write `recipes/<slug>.json`** following the schema below.
3. **Render:** `python3 render_recipe.py recipes/<slug>.json`. It exits non-zero
   on a malformed tree (childless operation, cell collision).
4. **Look at it** before showing the user — the layout is visual, so verify it:
   ```
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
     --disable-gpu --hide-scrollbars --screenshot=<scratchpad>/out.png \
     --window-size=1100,1700 "file://$PWD/recipes/<slug>.html"
   ```
   Then Read the PNG. Raise `--window-size` height if the page is cut off.
5. **Publish** with the Artifact tool (favicon 📋), then tell the user the local
   HTML path and the URL.

## Schema

```jsonc
{
  "title": "Espresso Brownies",
  "tags": ["one pan", "no mixer"],   // eyebrow line; factual, from the recipe
  "deck": "One sentence describing the dish.",
  "serves": 9,                       // a number — enables the serving rescaler
  "yield": "9 squares",              // every field below is optional
  "vessel": "8x8-in pan",
  "oven": "350°F (170°C)",
  "active": "20 min",                // hands-on time
  "time": "30 to 40 min",
  "source": "https://…",             // rendered as a link to the host
  "credit": "Adapted from …",        // attribution, shown in the footer
  "prep":   ["Preheat oven to 350°F (170°C)"],   // full-width rows above the table
  "finish": ["Cool 15 min, then turn out"],      // full-width rows below it
  "tree":   { … },                   // single-component recipe
  "sections": [                      // OR: multi-component, each its own table
    { "name": "cake", "prep": [], "tree": { … }, "finish": [] }
  ],
  "notes": [                         // footer cards; plain strings also accepted
    { "title": "Weigh the flour", "body": "Or spoon and sweep — scooping packs it." }
  ]
}
```

Tree nodes are one of:

```jsonc
{ "item": "1 cup (200 g) sugar", "note": "room temperature" }   // leaf: an ingredient
{ "item": "cooled cake layers", "from": "cake" }               // leaf: result of an earlier section
{ "op": "fold in", "detail": "low speed,\nuntil just combined", "children": [ … ] }
```

`note` and `detail` are secondary lines set in mono; `\n` is preserved.

**Optional quantity fields on an ingredient** let the page rescale servings. Add
them only where the source states the amount — `item` stays the display text and
the authority:

```jsonc
{
  "item": "2 cups (240 g) all-purpose flour",   // verbatim, always
  "name": "all-purpose flour",                  // the same, quantity stripped
  "amount": 2, "unit": "cups",
  "metric": 240, "metric_unit": "g"             // ONLY if the source printed it
}
```

Never compute a metric figure the source didn't give, and never round. An
ingredient with `amount` but no `name` is a bug — the pair is what makes scaling
work. Put a duration in `detail` whenever the source gives one; the page reads
those to time each step.

## Building the tree

- **Every ingredient is a leaf, and every leaf has exactly one parent.** Leaf
  order top-to-bottom is whatever the tree dictates, not the source's list
  order — that's expected.
- **An ingredient used at two stages becomes two leaves.** Ghee for searing and
  again for the sauce, "1/4 cup butter, divided", salt added at three points:
  one leaf per use, each with the amount used there and a `note` naming the use
  ("for searing"). A row cannot feed two operations, so listing it once and
  wiring it to both is invalid — and if the source gives only a combined amount,
  say "divided" in the note rather than guessing the split.
- **Every internal node is one operation** applied to everything beneath it.
  Label it with a lowercase verb or two (`mix`, `fold in`, `beat`, `whisk`,
  `sear`, `simmer`, `knead`). Put temperature, time, speed, and the visual cue
  in `detail`, not in the label.
- **A one-child operation is normal** — `melt` on butter alone, `sift` on flour.
- **Steps that don't combine ingredients are not nodes.** Preheating, greasing a
  pan, and resting the dough go in `prep`; dividing between pans, cooling,
  cutting, and doneness cues go in `finish`; storage goes in `notes`. If a step
  from the source lands in none of these, you dropped it — find it a home.
- **Children read top to bottom in listed order.** When one child is the base
  the rest get added to, list it first so the flow reads downward.
- **Consecutive steps in the same pan nest; they are not siblings.** Two
  operations share a parent only when they happened in separate vessels and are
  being brought together (the cake's whisked dry mix meeting its beaten eggs).
  Softening onions, then adding spices to that pan, then the tomato paste, is a
  chain three deep — as siblings they render as three operations stacked in one
  column, which reads as nonsense. A verb like "add", "stir in" or "return" is
  the giveaway that an operation continues from another.
- **The tree's post-order is the cooking sequence**, and the page walks it as
  numbered stages. A tree that is right as a diagram is therefore right as a
  procedure — if the stage order reads wrong for a cook, the tree is wrong.
- **Split into `sections`** when the recipe has separate components (cake +
  frosting, filling + dough, sauce + protein), with a final `assembly` section
  that pulls them together via `"from"` leaves.
- **Keep both unit systems** and any brand or state qualifier the source gives
  ("natural cocoa powder", "cut into pats"). Don't round, convert, or reword
  quantities.

## Keeping the two renderers in sync

`render_recipe.py` and `extension/shared/layout.js` implement the same layout and
emit byte-identical markup — one for the CLI, one for the Chrome extension. If you
change the markup or layout in either, change both and run
`python3 tests/parity.py`, which fails on any difference. The stylesheet
(`extension/shared/recipe-table.css`) is shared verbatim, so style-only changes
need no port.

`node tests/pipeline.mjs` covers the extension's flat-graph → tree conversion and
its validation errors.

## Checks before publishing

- Ingredient count in the tables equals the source's ingredient count.
- Every instruction step is represented as an operation, prep row, finish row,
  or note.
- Temperatures and times appear on the operation that needs them.
- No invented ingredient, quantity, temperature, or time. If the source omits
  something (no metric weights, no pan size), leave the field out.
