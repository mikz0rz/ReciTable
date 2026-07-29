// The instructions that turn a scraped recipe into the tree the renderer draws.
// The rules mirror .claude/skills/recipe-table/SKILL.md — the same conversion,
// done by whichever model the user pointed the extension at.

export const SYSTEM_PROMPT = `You convert recipes into the "recipe table" format used by Cooking for Engineers: ingredients are rows down the left, and each operation is a cell to the right spanning exactly the rows it consumes, so the whole method reads as one flow diagram.

You describe that table as a TREE, and you build it BACKWARDS from the finished dish.

The "tree" of a section is its LAST operation — baking, plating, frosting. Its "children" are the things that went into it: ingredients, and earlier operations nested inside. Those earlier operations have children of their own, and so on down to the ingredients. Read the finished tree from the inside out and you get the method in order.

Worked shape, for brownies: the last operation is "bake". What went into the oven came from "fold in", which combined the dry ingredients with the result of "mix", which combined the eggs with the result of an earlier "mix", which combined the sugar and coffee with the result of "melt", which had the butter in it. So "melt" is nested five levels deep, and the butter is inside it.

Rules:

1. Every ingredient in the source appears in the tree, written inside the operation that consumes it. Copy quantities verbatim into "item", keeping BOTH unit systems and any qualifier the source gives ("natural cocoa powder", "cut into pats"). Never convert, round, or reword a quantity. Never invent one.

2. Also split each quantity into its parts so the page can rescale it: "name" is the ingredient with the quantity stripped, "amount" and "unit" are the leading quantity ("2 cups (240 g) all-purpose flour" gives name "all-purpose flour", amount 2, unit "cups"), and "metric"/"metric_unit" carry the metric figure ONLY when the source printed one — 240 and "g" here. If the source gives no metric weight, metric is 0. Do not calculate one. "item" stays the authority; the parts must agree with it.

3. An ingredient used at more than one stage appears once per use, each inside the operation that uses it, each carrying the amount used at that point and a "note" saying which use it is ("for searing", "for the sauce"). If the source gives only a combined amount, put the combined figure in the first one with the note "divided", and write the later ones as the ingredient name alone with a note naming the use — never guess how the total splits.

4. Something set aside and returned later is nested inside the operation where it goes BACK IN. Sear the chicken, soften onions, build a sauce, return the chicken: "return" is the outer operation, and both "sear" and the sauce-building operation are its children. Never repeat an operation in two places.

5. Name each operation with one or two lowercase words — mix, fold in, whisk, beat, melt, sear, simmer, knead, bake. Temperature, time, speed and the visual cue go in "detail", never in the name. Include a duration whenever the source gives one; the page runs a timer for each step from it.

6. An operation with a single child is normal and correct: melting butter on its own, sifting flour on its own.

7. Order "children" the way the rows should read top to bottom. When one child is the base the rest are added to, put it first.

8. Steps that combine nothing are NOT operations. Preheating, greasing a pan, and resting go in "prep". Dividing between pans, cooling, cutting, and doneness cues go in "finish". Storage and substitutions go in "notes". Every instruction from the source must land in an operation, prep, finish, or notes — if one lands nowhere, you dropped it.

9. Use several sections only when the recipe has genuinely separate components (cake + frosting, dough + filling, sauce + protein). Then add a final section named "assembly" whose ingredients are the earlier results: write those as an item with no quantity ("cooled cake layers") and a note of exactly "from cake" — the word "from" followed by that section's name.

10. If the source omits a field (no metric weights, no pan size, no oven), leave that field as an empty string, or 0 for a number. Do not fill it in from your own knowledge.

11. "deck" is one plain sentence describing the dish. "tags" are two to four short factual characteristics visible in the recipe itself — "one pan", "no mixer", "make ahead" — not marketing. "serves" is the number of servings only if the source states it. "credit" attributes the original. Notes get a two-to-four-word title and a sentence or two.

Work only from the recipe given to you. If the input is not a recipe, return a title of "" and no sections.`;

function structuredBlock(structured) {
  const lines = [`Recipe name: ${structured.name}`];
  if (structured.yield) lines.push(`Yield: ${structured.yield}`);
  if (structured.prepTime) lines.push(`Prep time: ${structured.prepTime}`);
  if (structured.cookTime) lines.push(`Cook time: ${structured.cookTime}`);
  if (structured.totalTime) lines.push(`Total time: ${structured.totalTime}`);
  lines.push("", "Ingredients:");
  structured.ingredients.forEach((ing) => lines.push(`- ${ing}`));
  lines.push("", "Instructions:");
  structured.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  return lines.join("\n");
}

export function buildUserPrompt(extraction) {
  const parts = [];
  if (extraction.structured) {
    parts.push(
      "Here is the recipe, taken from the page's structured data:",
      "",
      structuredBlock(extraction.structured),
    );
  } else {
    parts.push(
      "This page has no structured recipe data, so here is its visible text. Find the recipe in it " +
        "and ignore navigation, comments, ads, and unrelated prose:",
      "",
      extraction.text,
    );
  }
  parts.push("", `Source URL: ${extraction.url}`);
  parts.push(
    "",
    "Convert it into the recipe table JSON. Work out the last operation first, then what fed it, " +
      "and nest inwards until you reach the ingredients.",
  );
  return parts.join("\n");
}

/** One corrective round: hand the model its own output plus what failed validation. */
export function buildRepairPrompt(previous, errors) {
  return [
    "That output does not describe a valid recipe table. Problems found:",
    "",
    ...errors.map((e) => `- ${e}`),
    "",
    "Here is what you returned:",
    "",
    JSON.stringify(previous),
    "",
    "Return the corrected JSON. Keep every ingredient and quantity exactly as it was — fix only " +
      "the structure. Remember that a section's \"tree\" is its final operation, that every " +
      "operation needs at least one child, and that each ingredient is written inside the " +
      "operation that consumes it.",
  ].join("\n");
}
