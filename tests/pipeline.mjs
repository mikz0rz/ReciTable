// Exercise the extension's conversion path with no network and no API key:
// the flat graph a model returns -> validation -> nested tree -> markup.
//
// The positive case reproduces recipes/espresso-brownies.json exactly, so if
// buildTree ever mis-assembles the graph the rendered markup stops matching a
// file we know is correct.
//
// Usage: node tests/pipeline.mjs

import { readFileSync } from "node:fs";
import { validateRecipe, buildTree } from "../extension/shared/schema.js";
import { renderArticle } from "../extension/shared/layout.js";
import { parseJsonLoosely } from "../extension/shared/providers.js";
import { ALL_SCENES, sceneFor } from "../extension/shared/kitchen.js";

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------- happy path

const BROWNIES_WIRE = {
  "title": "Espresso Brownies",
  "deck": "Melted-butter brownies with a shot of strong coffee worked into the batter.",
  "tags": [
    "one pan",
    "no mixer",
    "espresso in the batter"
  ],
  "serves": 9,
  "yield": "9 squares",
  "vessel": "8x8-in pan",
  "oven": "350°F (170°C)",
  "active": "",
  "time": "30 to 40 min",
  "credit": "Adapted from Michael Chu's Cooking for Engineers, where this layout comes from.",
  "notes": [],
  "sections": [
    {
      "name": "",
      "prep": [
        "Butter and flour an 8x8-in pan",
        "Preheat oven to 350°F (170°C)"
      ],
      "finish": [],
      "tree": {
        "op": "bake",
        "detail": "350°F (170°C)\n30 to 40 min",
        "children": [
          {
            "op": "fold in",
            "detail": "",
            "children": [
              {
                "op": "mix",
                "detail": "",
                "children": [
                  {
                    "op": "mix",
                    "detail": "",
                    "children": [
                      {
                        "op": "melt",
                        "detail": "",
                        "children": [
                          {
                            "item": "4 oz (115 g) unsalted butter",
                            "name": "unsalted butter",
                            "amount": 4,
                            "unit": "oz",
                            "metric": 115,
                            "metric_unit": "g",
                            "note": ""
                          }
                        ]
                      },
                      {
                        "item": "1 cup (200 g) sugar",
                        "name": "sugar",
                        "amount": 1,
                        "unit": "cup",
                        "metric": 200,
                        "metric_unit": "g",
                        "note": ""
                      },
                      {
                        "item": "1/4 tsp. (2.5 mL) vanilla extract",
                        "name": "vanilla extract",
                        "amount": 0.25,
                        "unit": "tsp.",
                        "metric": 2.5,
                        "metric_unit": "mL",
                        "note": ""
                      },
                      {
                        "item": "1 shot (4 Tbs; 60 mL) fresh brewed espresso or very strong coffee",
                        "name": "fresh brewed espresso or very strong coffee",
                        "amount": 4,
                        "unit": "Tbs",
                        "metric": 60,
                        "metric_unit": "mL",
                        "note": ""
                      }
                    ]
                  },
                  {
                    "item": "2 large (100 g) eggs",
                    "name": "eggs",
                    "amount": 2,
                    "unit": "large",
                    "metric": 100,
                    "metric_unit": "g",
                    "note": ""
                  }
                ]
              },
              {
                "item": "1/2 cup (80 g) all-purpose flour",
                "name": "all-purpose flour",
                "amount": 0.5,
                "unit": "cup",
                "metric": 80,
                "metric_unit": "g",
                "note": ""
              },
              {
                "item": "1/3 cup (80 g) Hershey's cocoa powder",
                "name": "Hershey's cocoa powder",
                "amount": 0.3333,
                "unit": "cup",
                "metric": 80,
                "metric_unit": "g",
                "note": ""
              },
              {
                "item": "1/4 tsp. (1.3 g) baking soda",
                "name": "baking soda",
                "amount": 0.25,
                "unit": "tsp.",
                "metric": 1.3,
                "metric_unit": "g",
                "note": ""
              },
              {
                "item": "1/4 tsp. (1.5 g) table salt",
                "name": "table salt",
                "amount": 0.25,
                "unit": "tsp.",
                "metric": 1.5,
                "metric_unit": "g",
                "note": ""
              }
            ]
          }
        ]
      }
    }
  ]
};

const valid = validateRecipe(BROWNIES_WIRE);
check("a valid recipe tree passes validation", valid.ok, valid.errors.join(" "));

const built = buildTree(structuredClone(BROWNIES_WIRE));
const expected = JSON.parse(readFileSync(new URL("../recipes/espresso-brownies.json", import.meta.url)));
const builtHtml = renderArticle(structuredClone(built));
const expectedHtml = renderArticle(structuredClone(expected));
check(
  "the wire tree rebuilds the known-good brownie table byte for byte",
  builtHtml === expectedHtml,
  builtHtml === expectedHtml ? "" : `built ${builtHtml.length} bytes vs expected ${expectedHtml.length}`,
);

// A single unnamed section should flatten into a top-level tree, not a sections array.
check("single unnamed section flattens to a top-level tree", "tree" in built && !("sections" in built));

// ------------------------------------------------------- cross-section refs

const ing = (item, note = "") => ({
  item, name: "", amount: 0, unit: "", metric: 0, metric_unit: "", note,
});

const TWO_SECTION = {
  title: "Two Part",
  deck: "", tags: [], serves: 0, yield: "", vessel: "", oven: "", active: "",
  time: "", credit: "", notes: [],
  sections: [
    {
      name: "base",
      prep: [], finish: [],
      tree: { op: "sift", detail: "", children: [ing("1 cup flour")] },
    },
    {
      name: "assembly",
      prep: [], finish: [],
      // A carried-over result is just an ingredient whose note names its origin.
      tree: { op: "use", detail: "", children: [ing("sifted flour", "from base")] },
    },
  ],
};
const twoValid = validateRecipe(TWO_SECTION);
check("multi-section recipe validates", twoValid.ok, twoValid.errors.join(" "));
const twoBuilt = buildTree(structuredClone(TWO_SECTION));
check("multi-section recipe keeps its sections", (twoBuilt.sections || []).length === 2);
check(
  'a note of "from base" becomes a carried-over reference',
  twoBuilt.sections?.[1]?.tree?.children?.[0]?.from === "base" &&
    !twoBuilt.sections?.[1]?.tree?.children?.[0]?.note,
);
check(
  "carried-over cell renders with the reference class",
  renderArticle(structuredClone(twoBuilt)).includes('class="ing ref"'),
);

// --------------------------------------------- the errors still worth catching
//
// Dangling references, cycles, and an entry consumed by two operations are no
// longer possible to express: the tree has no ids to mis-wire. What remains is
// structural emptiness and half-given quantities.

const base = () => structuredClone(BROWNIES_WIRE);
const firstError = (mutate) => {
  const recipe = base();
  mutate(recipe.sections[0], recipe);
  const result = validateRecipe(recipe);
  return result.ok ? "" : result.errors.join(" | ");
};

/** The first ingredient is five operations deep in this tree; go and find it. */
const firstIngredient = (node) =>
  "children" in node ? node.children.map(firstIngredient).find(Boolean) : node;

/** The innermost operation, the one holding that ingredient. */
const innermostOp = (node) => {
  const nested = (node.children || []).filter((c) => "children" in c).map(innermostOp);
  return nested.find(Boolean) || ("children" in node ? node : null);
};

const childless = firstError((s) => {
  innermostOp(s.tree).children = [];
});
check("operation with no children is caught", /has no children/.test(childless), childless);

const noTree = firstError((s) => {
  delete s.tree;
});
check("section with no tree is caught", /no "tree"/.test(noTree), noTree);

const emptyItem = firstError((s) => {
  firstIngredient(s.tree).item = "";
});
check("ingredient with an empty item is caught", /empty "item"/.test(emptyItem), emptyItem);

const namelessAmount = firstError((s) => {
  firstIngredient(s.tree).name = "";
});
check("amount without a name is caught", /but no name/.test(namelessAmount), namelessAmount);

const noIngredients = firstError((s) => {
  s.tree = { op: "bake", detail: "", children: [{ op: "stir", detail: "", children: [] }] };
});
check("a section with no ingredients is caught", /no children|no ingredients/.test(noIngredients), noIngredients);

check(
  "the error text names the offending operation, for the repair prompt",
  /operation "melt"/.test(childless),
  childless,
);

// ------------------------------------------------- stages and quantity markup

const brownieHtml = renderArticle(structuredClone(expected));

// Stage order is the order a cook works in: the two prep rows, then the
// operations in post-order (melt, mix, mix, fold in, bake).
check(
  "prep rows take the first stages",
  /class="prep" colspan="6" data-stage="1"/.test(brownieHtml) &&
    /class="prep" colspan="6" data-stage="2"/.test(brownieHtml),
);
check(
  "the innermost operation is staged before the ones that consume it",
  /data-stage="3" data-rows="0"><span class="verb">melt/.test(brownieHtml),
);
check(
  "the final operation is staged last and spans every ingredient",
  /data-stage="7" data-rows="0,1,2,3,4,5,6,7,8"><span class="verb">bake/.test(brownieHtml),
);
check(
  "ingredient rows carry their index",
  /class="ing" data-row="0" data-amount="4" data-unit="oz" data-metric="115"/.test(brownieHtml),
);
check(
  "a fixed colgroup is emitted so long details cannot squeeze the ingredients",
  /<colgroup><col class="c-ing" style="width: 41.5%">(<col style="width: 11.7%">){5}<\/colgroup>/.test(
    brownieHtml,
  ),
);

// ------------------------------------------------------- numbers and durations

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => ({}),
};
await import("../extension/shared/interactive.js");
const { fmtAmount, fmtMetric, parseSeconds } = globalThis.__reciTableInternals;

const amounts = [
  [0.5, "1/2"], [0.25, "1/4"], [0.125, "1/8"],
  [0.6666, "2/3"],      // thirds survive, rather than collapsing to 5/8
  [1.5, "1 1/2"], [2, "2"], [8, "8"],
  [0.9375, "7/8"],      // exactly between 7/8 and 1: keep the finer measurement
  [0.98, "1"],          // close enough to whole
  [2.98, "3"],
  [12.5, "13"],         // above 10, fractions of a cup stop being useful
];
check(
  "amounts round to fractions a cook would measure",
  amounts.every(([input, want]) => fmtAmount(input) === want),
  amounts.filter(([i, w]) => fmtAmount(i) !== w).map(([i, w]) => `${i} -> ${fmtAmount(i)} not ${w}`).join(", "),
);

const metrics = [[230, "230"], [794, "795"], [5, "5"], [2.6, "2.6"], [40, "40"]];
check(
  "metric amounts round sensibly by magnitude",
  metrics.every(([input, want]) => fmtMetric(input) === want),
  metrics.filter(([i, w]) => fmtMetric(i) !== w).map(([i, w]) => `${i} -> ${fmtMetric(i)}`).join(", "),
);

const durations = [
  ["25\u201330 min", 1650],        // a range times its midpoint
  ["5-6 min", 330],
  ["2 min", 120],
  ["1 hr", 3600],
  ["1 hr 30 min", 5400],           // components sum while they get smaller
  ["350\u00b0F (170\u00b0C)\n30 to 40 min", 2100],  // temperatures are not durations
  ["325\u00b0F\n26\u201330 min (9\")\n38\u201342 min (8\")", 1680], // stops at the first bake time
  ["8\u201310 min \u00b7 reserve 1 cup", 540],       // "1 cup" is not a duration
  ["low speed, just combined", 0],
  ["to a simmer", 0],
];
check(
  "durations are read out of detail prose",
  durations.every(([text, want]) => parseSeconds(text) === want),
  durations.filter(([t, w]) => parseSeconds(t) !== w).map(([t, w]) => `${JSON.stringify(t)} -> ${parseSeconds(t)} not ${w}`).join("; "),
);

// ----------------------------------------------------------- the ascii kitchen

check(
  "every frame of every scene is the same box, so the art cannot jitter",
  ALL_SCENES.every(
    (scene) =>
      new Set(scene.frames.map((f) => f.split("\n").map((l) => l.length).join("x"))).size === 1,
  ),
  ALL_SCENES.filter(
    (scene) =>
      new Set(scene.frames.map((f) => f.split("\n").map((l) => l.length).join("x"))).size !== 1,
  ).map((s) => s.name).join(", "),
);
check("the art follows the step: reading", sceneFor("Read the page")?.name === "read");
check("the art follows the step: plating", sceneFor("Draw the table")?.name === "plate");
check(
  "a long model call matches nothing, so the dishes rotate instead",
  sceneFor("Ask poolside/laguna-s-2.1:free receiving 3.4 kB") === null,
);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
