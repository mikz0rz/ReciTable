// The instructions that turn a scraped recipe into a flat ingredient/step graph.
// The rules mirror .claude/skills/recipe-table/SKILL.md — the same conversion,
// done by whichever model the user pointed the extension at.

export const SYSTEM_PROMPT = `You convert recipes into the "recipe table" format used by Cooking for Engineers: ingredients are rows down the left, and each operation is a cell to the right spanning exactly the rows it consumes, so the whole method reads as one flow diagram.

You output JSON describing that structure as a flat graph. Ingredients and steps each carry an id; a step lists the ingredient ids and earlier step ids it consumes in its "inputs".

Rules:

1. Every ingredient in the source appears as an ingredient entry, and every entry is consumed by exactly one step. Copy quantities verbatim into "item", keeping BOTH unit systems and any qualifier the source gives ("natural cocoa powder", "cut into pats"). Never convert, round, or reword a quantity. Never invent one.

1b. An ingredient used at more than one stage gets ONE ENTRY PER USE — this is the single most common mistake. Ghee for searing and again for the sauce, oil divided between two pans, salt added at three points, "1/4 cup butter, divided": each use is its own entry, with its own id, carrying the amount used at that point and a "note" saying which use it is ("for searing", "for the sauce"). If the source gives only a combined amount, put the combined figure in the first entry's "item" with the note "divided", and for the later uses write the item as the ingredient name alone with a note naming the use — never guess how the total splits. Do not list an ingredient once and feed it to two steps: the table is a tree, so a row belongs to exactly one operation.

1a. Also split each quantity into its parts so the page can rescale it: "name" is the ingredient with the quantity stripped, "amount" and "unit" are the leading quantity ("2 cups (240 g) all-purpose flour" gives name "all-purpose flour", amount 2, unit "cups"), and "metric"/"metric_unit" carry the metric figure ONLY when the source printed one — 240 and "g" here. If the source gives no metric weight, metric is 0. Do not calculate one. "item" stays the authority; these parts must agree with it exactly.
2. Every step is one operation that combines its inputs. Name it with one or two lowercase words — mix, fold in, whisk, beat, melt, sear, simmer, knead, bake. Put temperature, time, speed, and the visual cue in "detail", never in "op".
3. A step with a single input is normal and correct: melting butter alone, sifting flour alone.
4. Each ingredient and each step feeds exactly one later step. Exactly one step in a section is consumed by nothing — the final one. Chain everything into that single step; do not leave two independent finished steps.
5. Order "inputs" the way the rows should read top to bottom. When one input is the base the rest get added to, list it first.
6. Steps that combine nothing are NOT steps. Preheating, greasing a pan, and resting go in "prep". Dividing between pans, cooling, cutting, and doneness cues go in "finish". Storage and substitutions go in "notes". Every instruction from the source must land in a step, prep, finish, or notes — if one lands nowhere, you dropped it.
7. Use several sections only when the recipe has genuinely separate components (cake + frosting, dough + filling, sauce + protein). Then add a final section named "assembly" whose ingredients are the earlier results: give those an empty quantity-free item like "cooled cake layers" and set "from" to the section they came from.
8. If the source omits a field (no metric weights, no pan size, no oven), leave that field as an empty string, or 0 for a number. Do not fill it in from your own knowledge.

9. "deck" is one plain sentence describing the dish. "tags" are two to four short factual characteristics visible in the recipe itself — "one pan", "no mixer", "make ahead" — not marketing. "serves" is the number of servings only if the source states it. "credit" attributes the original. Notes get a two-to-four-word title and a sentence or two: storage, substitutions, why a step matters.

10. Put a duration in the operation's "detail" whenever the source gives one ("25-30 min", "2 min", "1 hr"), phrased as the source phrased it. The page reads those to run a timer for each step, so a step with a stated time and no duration in its detail loses its timer.

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
  parts.push("", "Convert it into the recipe table JSON.");
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
    "Return the corrected JSON. Keep every ingredient and quantity exactly as it was — fix only the " +
      "structure. Remember that each ingredient and step feeds exactly one later step, and that a " +
      "section ends in a single final step.",
  ].join("\n");
}
