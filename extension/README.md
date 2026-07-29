# ReciTable — the Chrome extension

Turns the recipe on the page you're reading into a nested table: ingredients down
the left, each operation a cell spanning the rows it consumes.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this
   `extension/` folder. There's no build step.
2. Click the toolbar icon → **settings**.
3. Pick a provider, paste a key, press **Load models**, choose one, **Save**.
   **Test** confirms the key works and reports how well that model handles JSON.

## The flow

Click the toolbar icon on any recipe page and press **Convert this recipe**. Then:

1. The **dropdown** shows the run as it happens — one line per step with its own
   timing — and turns its button into **Cancel**. It is also where a failure is
   explained, with **Copy diagnostics**.
2. The **badge** animates so the work stays visible from any tab, with the current
   step in the icon's tooltip.
3. A tab opens **quietly beside the page you're on** — unfocused, so you keep
   reading the recipe. Its title carries the current step and elapsed time, so
   progress is readable from the tab strip.
4. That tab **becomes the table** and comes forward when it's ready. It never
   steals focus from another application; if you've left the browser, a
   notification tells you instead.

From the table you can print it, save it as a standalone HTML file, or save the
recipe JSON (which `render_recipe.py` accepts).

## Providers

Any of these work — the extension speaks both the OpenAI and Anthropic wire formats:

| Provider | Notes |
| --- | --- |
| **OpenRouter** | Default. The model list can be filtered to **free** models (`:free`), which cost nothing but are rate-limited and vary in quality. |
| **Anthropic** | Defaults to `claude-opus-5`. |
| **OpenAI** | Any chat model on the account. |
| **Other OpenAI-compatible** | Your own base URL — a company gateway, or a local server like `http://localhost:11434/v1` for Ollama. Chrome asks for permission for that host on save. |

**Where your key goes:** into this browser's extension storage, and out only to the
provider you picked. Requests go straight from your browser to that provider —
nothing passes through any intermediary — and page content is sent only when you
press Convert.

## How a page becomes a table

1. **Extract** — [extract.js](extract.js) reads the page's `Recipe` JSON-LD (most
   recipe sites publish it), falling back to microdata, then to visible text.
2. **Convert** — the model gets that plus the rules in
   [shared/prompt.js](shared/prompt.js) and returns the **tree**: each ingredient
   written inside the operation that consumes it, built backwards from the finished
   dish. [shared/schema.js](shared/schema.js) spells the tree out to a fixed depth,
   because JSON Schema can't express recursion.
3. **Validate** — there are no ids, so a dangling reference, a cycle, or an
   ingredient consumed twice cannot be expressed at all. What's left to check is
   emptiness and half-given quantities; a failure goes back to the model once,
   naming what broke.
4. **Render** — [shared/layout.js](shared/layout.js) assembles the tree and
   computes the rowspan/colspan layout, stamping each operation with its stage in
   the cooking sequence (post-order of the tree) and the rows it consumes.
5. **Interact** — [shared/interactive.js](shared/interactive.js) reads those
   attributes to add cook mode, rescaling, and cross-off. See the main
   [README](../README.md#the-tree-already-knows-the-order-of-work).

Model output is never trusted on shape: a malformed graph produces a stated error
rather than a silently wrong table. The same applies to quantities — the model
must copy the source's text verbatim and split it into parts that agree with it;
it is told never to compute a metric figure the source didn't print.

## Shared with the CLI

`shared/recipe-table.css` and `shared/layout.js` are the single source of truth for
how a recipe table looks. `../render_recipe.py` reads the same stylesheet, and
`../tests/parity.py` asserts the Python and JS renderers emit byte-identical
markup. **Save JSON** in the viewer produces a file `render_recipe.py` accepts.

## Watching a run, and what happens when it fails

The worker writes a log of the run to session storage as it goes, and every view
reads only that. So no view holds state, and all of them agree:

```
     ( )     ( )
      (   )
   _______________
  |               |
  |  o    O    o  |
  |_______________|
  ^^^^^^^^^^^^^^^^^
  SOMETHING IS SIMMERING

✓ Read the page          0.3s
  structured data · 16 ingredients, 18 steps
· Ask cohere/…:free      8.2s
  receiving · 3.4 kB
```

The tab draws an ASCII kitchen while it waits ([shared/kitchen.js](shared/kitchen.js)).
It is not only decoration: the scene follows the step, so reading the page looks like a
recipe card and plating looks like a plate. The model call matches nothing, so through
the long wait it cycles dishes — a pot, a pancake, a whisk, a cake in the oven. A
failure burns the pan.

The dropdown is where you start and inspect a run, but Chrome closes it the moment
it loses focus — so the tab and the badge are what carry a run once you look away.
The badge settles to `✓` briefly on success and to a red `!` on failure that stays
until the next run, so a failure is noticeable even with everything closed. The
notification fires **only when the browser is not the focused application** — the
one case where nothing on screen could tell you; clicking it brings the tab up.

Closing the tab mid-run doesn't stop the work: the result opens in a fresh tab when
it's done. **Cancel** and **Copy diagnostics** are in both the dropdown and the tab.

Responses are **streamed**, which is less about speed than about telling a working
model apart from a wedged one — and it makes the stall deadline meaningful, since
a model that is thinking keeps the connection warm while a queued one does not.

Deadlines and failure reporting:

- **60s with nothing arriving** ends the attempt and says the model is probably
  queued or overloaded. **300s** is the hard cap. **Cancel** aborts immediately.
- HTTP failures name the likely cause: 401 points at the key, 429 at the shared
  free-model quota, 404 at the model id, 5xx at the provider.
- Ending mid-JSON, replying with prose, refusing, hitting the output limit, or
  dying mid-stream each get their own message rather than a generic failure.
- A run still marked running when nothing is running means Chrome restarted the
  worker underneath it; the log says so instead of spinning. A heartbeat keeps the
  worker awake during a request to make that rare.
- **Copy diagnostics** puts the whole log, the provider error, and the browser
  version on the clipboard, with no API key in it.

Full stack traces live in the worker console: `chrome://extensions` → ReciTable →
**Inspect views: service worker**.

## Tests

```
python3 tests/parity.py      # Python and JS renderers agree exactly
node tests/pipeline.mjs      # flat graph -> validation -> tree -> markup
node tests/providers.mjs     # streaming, fallback ladders, every failure path
```

None need a key or a network — `providers.mjs` stubs `fetch`, including a stream
that opens and then says nothing, which is the shape of the hang that motivated
the deadlines. Regenerate the toolbar icons with
`python3 extension/icons/make_icons.py`.
