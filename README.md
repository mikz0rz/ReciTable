# ReciTable

Plain recipe in → gorgeous step-by-step table out. A browser extension for people
who actually cook.

Ingredients run down the left; each operation is a cell spanning exactly the rows
it consumes, so the method reads as one flow diagram — the
[Cooking for Engineers](https://www.cookingforengineers.com) format.

Two ways in:

**In the browser** — a Chrome extension that converts the page you're reading.
Load [extension/](extension/) unpacked, add an API key (OpenRouter's free models
work), and click the toolbar icon. See [extension/README.md](extension/README.md).

**From the command line** — a recipe as JSON:

```
python3 render_recipe.py recipes/espresso-brownies.json      # -> recipes/espresso-brownies.html
```

## How it works

A recipe is a tree: leaves are ingredients, internal nodes are operations. Each
operation sits one column right of its deepest child and spans its leaves' rows;
the ragged region left over is tiled with borderless spacers. That layout is
computed, never hand-written — twice, in fact:

| | Used by | |
| --- | --- | --- |
| [render_recipe.py](render_recipe.py) | the CLI | JSON tree → standalone HTML |
| [extension/shared/layout.js](extension/shared/layout.js) | the extension | same, in the browser |
| [extension/shared/recipe-table.css](extension/shared/recipe-table.css) | both | the single stylesheet |
| [extension/shared/interactive.js](extension/shared/interactive.js) | both | the affordances below |

[tests/parity.py](tests/parity.py) asserts the two renderers emit byte-identical
markup, so they can't drift.

### The tree already knows the order of work

**Post-order traversal of the tree is the sequence a cook follows** — whisk the
dry, beat the eggs, combine, heat the milk, stir in the fats, add to the batter,
bake. Nothing has to be authored for that: the renderers stamp each operation
with its stage number, and each operation already spans exactly the rows it
consumes. So a rendered page can offer, with no extra data:

- **Cook mode** — step through the stages; the current operation and only the
  ingredients feeding it stay lit while the rest recedes. Durations are read out
  of each operation's detail line ("25–30 min" starts a 27:30 timer), so a step
  with a stated time gets a timer for free. Arrow keys move, Escape exits.
- **Rescaling** — where the source stated an amount, the ingredient carries it as
  data, so servings can be halved or doubled. It rounds to fractions a cook can
  measure (⅓ cup doubled is ⅔, not 0.67), pluralises units, and tracks metric
  figures only when the source printed them — nothing is ever converted. Times,
  pan sizes, and oven temperatures deliberately do not scale, and a scaled yield
  is marked "× 2" rather than left claiming the original.
- **Crossing ingredients off** as you go.

Every control is built by the script, so with JS off the page is a clean table
rather than dead buttons — and it prints correctly, columns and tints intact.

## Tests

```
python3 tests/parity.py      # Python and JS renderers agree exactly
node tests/pipeline.mjs      # model output -> validation -> tree -> markup
node tests/providers.mjs     # streaming, fallback ladders, every failure path
```

No key or network needed — the provider tests stub `fetch`.

## Recipes

| Recipe | Source |
| --- | --- |
| [Espresso brownies](recipes/espresso-brownies.json) | Cooking for Engineers |
| [Classic birthday cake](recipes/classic-birthday-cake.json) | King Arthur Baking |

The schema and the rules for turning a recipe into a tree live in
[.claude/skills/recipe-table/SKILL.md](.claude/skills/recipe-table/SKILL.md) — in
Claude Code, paste a recipe link and the skill handles it.
