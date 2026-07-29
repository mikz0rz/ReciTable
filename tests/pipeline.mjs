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

const BROWNIES_FLAT = {
  title: "Espresso Brownies",
  deck: "Melted-butter brownies with a shot of strong coffee worked into the batter.",
  tags: ["one pan", "no mixer", "espresso in the batter"],
  serves: 9,
  yield: "9 squares",
  vessel: "8x8-in pan",
  oven: "350°F (170°C)",
  active: "",
  time: "30 to 40 min",
  credit: "Adapted from Michael Chu's Cooking for Engineers, where this layout comes from.",
  notes: [],
  sections: [
    {
      name: "",
      prep: ["Butter and flour an 8x8-in pan", "Preheat oven to 350°F (170°C)"],
      finish: [],
      ingredients: [
        { id: "i1", item: "4 oz (115 g) unsalted butter", name: "unsalted butter", amount: 4, unit: "oz", metric: 115, metric_unit: "g", note: "", from: "" },
        { id: "i2", item: "1 cup (200 g) sugar", name: "sugar", amount: 1, unit: "cup", metric: 200, metric_unit: "g", note: "", from: "" },
        { id: "i3", item: "1/4 tsp. (2.5 mL) vanilla extract", name: "vanilla extract", amount: 0.25, unit: "tsp.", metric: 2.5, metric_unit: "mL", note: "", from: "" },
        { id: "i4", item: "1 shot (4 Tbs; 60 mL) fresh brewed espresso or very strong coffee", name: "fresh brewed espresso or very strong coffee", amount: 4, unit: "Tbs", metric: 60, metric_unit: "mL", note: "", from: "" },
        { id: "i5", item: "2 large (100 g) eggs", name: "eggs", amount: 2, unit: "large", metric: 100, metric_unit: "g", note: "", from: "" },
        { id: "i6", item: "1/2 cup (80 g) all-purpose flour", name: "all-purpose flour", amount: 0.5, unit: "cup", metric: 80, metric_unit: "g", note: "", from: "" },
        { id: "i7", item: "1/3 cup (80 g) Hershey's cocoa powder", name: "Hershey's cocoa powder", amount: 0.3333, unit: "cup", metric: 80, metric_unit: "g", note: "", from: "" },
        { id: "i8", item: "1/4 tsp. (1.3 g) baking soda", name: "baking soda", amount: 0.25, unit: "tsp.", metric: 1.3, metric_unit: "g", note: "", from: "" },
        { id: "i9", item: "1/4 tsp. (1.5 g) table salt", name: "table salt", amount: 0.25, unit: "tsp.", metric: 1.5, metric_unit: "g", note: "", from: "" },
      ],
      steps: [
        { id: "s1", op: "melt", detail: "", inputs: ["i1"] },
        { id: "s2", op: "mix", detail: "", inputs: ["s1", "i2", "i3", "i4"] },
        { id: "s3", op: "mix", detail: "", inputs: ["s2", "i5"] },
        { id: "s4", op: "fold in", detail: "", inputs: ["s3", "i6", "i7", "i8", "i9"] },
        { id: "s5", op: "bake", detail: "350°F (170°C)\n30 to 40 min", inputs: ["s4"] },
      ],
    },
  ],
};

const valid = validateRecipe(BROWNIES_FLAT);
check("valid flat recipe passes validation", valid.ok, valid.errors.join(" "));

const built = buildTree(structuredClone(BROWNIES_FLAT));
const expected = JSON.parse(readFileSync(new URL("../recipes/espresso-brownies.json", import.meta.url)));
const builtHtml = renderArticle(structuredClone(built));
const expectedHtml = renderArticle(structuredClone(expected));
check(
  "flat graph rebuilds the known-good brownie table byte for byte",
  builtHtml === expectedHtml,
  builtHtml === expectedHtml ? "" : `built ${builtHtml.length} bytes vs expected ${expectedHtml.length}`,
);

// A single unnamed section should flatten into a top-level tree, not a sections array.
check("single unnamed section flattens to a top-level tree", "tree" in built && !("sections" in built));

// ------------------------------------------------------- cross-section refs

const TWO_SECTION = {
  title: "Two Part",
  yield: "",
  vessel: "",
  oven: "",
  time: "",
  notes: [],
  sections: [
    {
      name: "base",
      prep: [],
      finish: [],
      ingredients: [{ id: "a1", item: "1 cup flour", note: "", from: "" }],
      steps: [{ id: "b1", op: "sift", detail: "", inputs: ["a1"] }],
    },
    {
      name: "assembly",
      prep: [],
      finish: [],
      ingredients: [{ id: "a2", item: "sifted flour", note: "", from: "base" }],
      steps: [{ id: "b2", op: "use", detail: "", inputs: ["a2"] }],
    },
  ],
};
const twoValid = validateRecipe(TWO_SECTION);
check("multi-section recipe validates", twoValid.ok, twoValid.errors.join(" "));
const twoBuilt = buildTree(structuredClone(TWO_SECTION));
check("multi-section recipe keeps its sections", (twoBuilt.sections || []).length === 2);
check(
  "carried-over ingredient keeps its from marker",
  twoBuilt.sections?.[1]?.tree?.children?.[0]?.from === "base",
);
check(
  "carried-over cell renders with the reference class",
  renderArticle(structuredClone(twoBuilt)).includes('class="ing ref"'),
);

// --------------------------------------------------- the graph errors we expect

const base = () => structuredClone(BROWNIES_FLAT);
const firstError = (mutate) => {
  const recipe = base();
  mutate(recipe.sections[0]);
  const result = validateRecipe(recipe);
  return result.ok ? "" : result.errors.join(" | ");
};

const orphan = firstError((s) => {
  s.steps[3].inputs = ["s3", "i6", "i7", "i8"]; // drops the salt
});
check("unused ingredient is caught and named", /i9/.test(orphan) && /never used/.test(orphan), orphan);

const twoRoots = firstError((s) => {
  s.steps[4].inputs = ["s3"]; // leaves s4 finished too
});
check("two final steps are caught", /final/.test(twoRoots), twoRoots);

const dangling = firstError((s) => {
  s.steps[1].inputs = ["s1", "i2", "i3", "i99"];
});
check("dangling reference is caught", /i99/.test(dangling), dangling);

// An ingredient used at two stages (ghee for searing and again for the sauce) is
// the commonest real-world case. The message has to name the ingredient and say
// how to fix it, because it is fed straight back to the model as a repair prompt.
const reused = firstError((s) => {
  s.steps[3].inputs = ["s3", "i6", "i7", "i8", "i9", "i2"]; // i2 already in s2
});
check("ingredient consumed twice is caught", /more than one step/.test(reused), reused);
check("it names the ingredient, not just the id", /1 cup \(200 g\) sugar/.test(reused), reused);
check(
  "it says to split the entry per use",
  /one entry per use/.test(reused) && /own id/.test(reused),
  reused,
);

const childless = firstError((s) => {
  s.steps.push({ id: "s6", op: "garnish", detail: "", inputs: [] });
});
check("operation with no inputs is caught", /no inputs/.test(childless), childless);

const cyclic = (() => {
  const recipe = base();
  const s = recipe.sections[0];
  s.steps = [
    { id: "s1", op: "a", detail: "", inputs: ["s2", ...s.ingredients.map((i) => i.id)] },
    { id: "s2", op: "b", detail: "", inputs: ["s1"] },
  ];
  const result = validateRecipe(recipe);
  return result.ok ? "" : result.errors.join(" | ");
})();
check("cycle is caught", /cycle/.test(cyclic), cyclic);

// -------------------------------------------------------- lenient JSON parsing

check("parses a fenced JSON block", parseJsonLoosely('```json\n{"a":1}\n```').a === 1);
check("parses JSON after prose", parseJsonLoosely('Sure! Here you go:\n{"a":2}\nHope that helps.').a === 2);
check("parses braces inside strings", parseJsonLoosely('{"a":"} not the end"}').a === "} not the end");
check(
  "reports truncated JSON clearly",
  (() => {
    try {
      parseJsonLoosely('{"a": [1, 2');
      return false;
    } catch (err) {
      return /cut off/.test(err.message);
    }
  })(),
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

// An amount with no name would be silently unusable for rescaling.
const namelessAmount = firstError((s) => {
  s.ingredients[0].name = "";
});
check("amount without a name is caught", /but no name/.test(namelessAmount), namelessAmount);

const metricOnly = firstError((s) => {
  s.ingredients[0].amount = 0;
});
check("metric without an amount is caught", /metric amount but no amount/.test(metricOnly), metricOnly);

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

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
