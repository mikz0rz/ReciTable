// The model's output contract, plus validation and conversion to the renderer's
// nested tree.
//
// The renderer wants a recursive tree, which no structured-output schema can
// express (Anthropic rejects recursive schemas outright; strict mode elsewhere
// is uneven). So the model emits a FLAT list of ingredients and steps that
// reference each other by id, and buildTree() assembles the tree here — where a
// malformed graph produces a precise error we can hand back for one repair pass
// instead of a silent mis-render.

/** JSON Schema for the flat wire format. Every field is required; "" and [] mean absent. */
export const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "deck", "tags", "serves", "yield", "vessel", "oven",
    "active", "time", "credit", "sections", "notes",
  ],
  properties: {
    title: { type: "string", description: "Dish name, e.g. 'Classic Birthday Cake'" },
    deck: {
      type: "string",
      description:
        "One plain sentence describing the dish, drawn from the source. \"\" if you would have to invent it.",
    },
    tags: {
      type: "array",
      description:
        "Two to four short factual characteristics — 'one pan', 'no mixer', 'make ahead'. " +
        "Only what the recipe itself shows. [] if nothing is clearly true.",
      items: { type: "string" },
    },
    serves: {
      type: "number",
      description:
        "How many the recipe serves, as a number, if the source states it (16 for '16 servings', " +
        "9 for '9 squares'). 0 if it does not. Never estimate.",
    },
    yield: { type: "string", description: "e.g. 'one two-layer 9\" cake'. \"\" if the source omits it." },
    vessel: { type: "string", description: "Pan/pot, e.g. 'two 9x2-in round pans'. \"\" if absent." },
    oven: { type: "string", description: "Oven temperature with both units. \"\" if not baked." },
    active: { type: "string", description: "Hands-on time if stated, e.g. '20 min'. \"\" if absent." },
    time: { type: "string", description: "Cook or bake time, e.g. '26-42 min'. \"\" if absent." },
    credit: {
      type: "string",
      description:
        "Attribution line, e.g. \"Adapted from King Arthur Baking's classic birthday cake.\" " +
        "\"\" if the source names no author or publication.",
    },
    notes: {
      type: "array",
      description: "Storage, substitutions, warnings, technique asides. Prose, not steps.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body"],
        properties: {
          title: { type: "string", description: "Two to four words, e.g. 'Weigh the flour'." },
          body: { type: "string", description: "One or two sentences." },
        },
      },
    },
    sections: {
      type: "array",
      description:
        "One per component. Single-component recipes use exactly one section with name \"\". " +
        "Multi-component recipes (cake + frosting) get one per component plus a final assembly section.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "prep", "finish", "ingredients", "steps"],
        properties: {
          name: { type: "string", description: "Component name, lowercase, e.g. 'frosting'. \"\" if single-component." },
          prep: {
            type: "array",
            description: "Setup that combines nothing: preheating, greasing a pan, resting dough.",
            items: { type: "string" },
          },
          finish: {
            type: "array",
            description: "Trailing steps that combine nothing: dividing, cooling, cutting, doneness cues.",
            items: { type: "string" },
          },
          ingredients: {
            type: "array",
            description: "Every ingredient in this component, exactly once each.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "item", "name", "amount", "unit", "metric", "metric_unit", "note", "from"],
              properties: {
                id: { type: "string", description: "Unique within the section, e.g. 'i1'." },
                item: {
                  type: "string",
                  description:
                    "Quantity and name verbatim from the source, keeping both unit systems, " +
                    "e.g. '2 cups (240 g) all-purpose flour'. This is what gets displayed.",
                },
                name: {
                  type: "string",
                  description:
                    "The same ingredient with the quantity stripped, e.g. 'all-purpose flour'. " +
                    "Used only for rescaling. \"\" if the entry has no quantity at all.",
                },
                amount: {
                  type: "number",
                  description:
                    "The leading quantity as a number: 2 for '2 cups', 0.25 for '1/4 tsp'. " +
                    "0 when the source gives no number ('salt to taste').",
                },
                unit: { type: "string", description: "Unit for amount: 'cups', 'tsp', 'large', 'cans'. \"\" if none." },
                metric: {
                  type: "number",
                  description:
                    "The metric quantity ONLY IF the source states one — 240 for " +
                    "'2 cups (240 g)'. 0 otherwise. Never convert or estimate it yourself.",
                },
                metric_unit: { type: "string", description: "'g' or 'mL'. \"\" if there is no metric amount." },
                note: { type: "string", description: "State qualifier, e.g. 'room temperature'. \"\" if none." },
                from: {
                  type: "string",
                  description:
                    "Only for a result carried over from an earlier section: the name of that " +
                    "section. \"\" for real ingredients.",
                },
              },
            },
          },
          steps: {
            type: "array",
            description:
              "Operations that combine things. Each consumes the ingredients and earlier steps " +
              "listed in inputs. Exactly one step must be unreferenced by any other — the final one.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "op", "detail", "inputs"],
              properties: {
                id: { type: "string", description: "Unique within the section, e.g. 's1'." },
                op: {
                  type: "string",
                  description: "One or two lowercase words: 'mix', 'fold in', 'beat', 'melt', 'bake'.",
                },
                detail: {
                  type: "string",
                  description:
                    "Temperature, time, speed, visual cue. Newlines allowed. \"\" if none. " +
                    "Never put the verb here.",
                },
                inputs: {
                  type: "array",
                  description: "Ingredient ids and step ids this operation consumes, in top-to-bottom order.",
                  items: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

function validateSection(section, index, errors) {
  const where = section.name ? `section "${section.name}"` : `section ${index + 1}`;
  const ingredients = section.ingredients || [];
  const steps = section.steps || [];

  if (!ingredients.length) errors.push(`${where}: has no ingredients.`);
  if (!steps.length) errors.push(`${where}: has no steps.`);

  const ids = new Map();
  for (const node of [...ingredients, ...steps]) {
    if (!node.id) errors.push(`${where}: an entry is missing its id.`);
    else if (ids.has(node.id)) errors.push(`${where}: id "${node.id}" is used more than once.`);
    else ids.set(node.id, node);
  }
  for (const ing of ingredients) {
    if (!ing.item) errors.push(`${where}: ingredient "${ing.id}" has an empty item.`);
    // Rescaling needs the amount and the bare name together; one without the
    // other would be silently dropped rather than half-working.
    if (Number(ing.amount) > 0 && !ing.name) {
      errors.push(
        `${where}: ingredient "${ing.id}" ("${ing.item}") gives an amount but no name — ` +
          "set name to the ingredient with the quantity stripped.",
      );
    }
    if (Number(ing.metric) > 0 && !(Number(ing.amount) > 0)) {
      errors.push(
        `${where}: ingredient "${ing.id}" ("${ing.item}") gives a metric amount but no amount.`,
      );
    }
  }
  for (const step of steps) {
    if (!step.op) errors.push(`${where}: step "${step.id}" has an empty op.`);
    if (!step.inputs || !step.inputs.length) {
      errors.push(`${where}: step "${step.id}" ("${step.op}") has no inputs — every operation must combine something.`);
    }
  }

  // Reference integrity.
  const referenced = new Set();
  for (const step of steps) {
    for (const ref of step.inputs || []) {
      if (!ids.has(ref)) {
        errors.push(`${where}: step "${step.id}" references "${ref}", which is not a known ingredient or step id.`);
        continue;
      }
      if (referenced.has(ref)) {
        const node = ids.get(ref);
        const what = node && node.item ? `"${node.item}"` : `"${ref}"`;
        errors.push(
          `${where}: ${what} (id ${ref}) is consumed by more than one step. The table is a tree, so ` +
            "every entry feeds exactly one step. If it really is used at two stages, split it into " +
            "one entry per use — each with its own id, the amount used at that point, and a note " +
            'naming the use ("for searing", "for the sauce") — and point each step at its own entry.',
        );
      }
      referenced.add(ref);
    }
  }

  for (const ing of ingredients) {
    if (!referenced.has(ing.id)) {
      errors.push(`${where}: ingredient "${ing.id}" ("${ing.item}") is never used by any step.`);
    }
  }

  const roots = steps.filter((s) => !referenced.has(s.id));
  if (roots.length === 0 && steps.length) {
    errors.push(`${where}: the steps form a cycle — no final step.`);
  } else if (roots.length > 1) {
    errors.push(
      `${where}: ${roots.length} steps are final (${roots.map((s) => `"${s.id}"`).join(", ")}) — ` +
        "they must feed into one another so a single step ends the section.",
    );
  }
  return roots[0];
}

/** Check the flat form. Returns { ok, errors } with errors phrased for a repair prompt. */
export function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") return { ok: false, errors: ["Output is not a JSON object."] };
  if (!recipe.title) errors.push("title is empty.");
  const sections = recipe.sections || [];
  if (!sections.length) errors.push("sections is empty — there must be at least one.");
  sections.forEach((section, i) => validateSection(section, i, errors));
  return { ok: errors.length === 0, errors };
}

function treeFor(node, byId, seen) {
  if (seen.has(node.id)) throw new Error(`cycle through "${node.id}"`);
  seen.add(node.id);
  if (!("inputs" in node)) {
    const leaf = { item: node.item };
    if (node.note) leaf.note = node.note;
    if (node.from) leaf.from = node.from;
    // Only carry quantity data through when it is complete enough to rescale.
    if (Number(node.amount) > 0 && node.name) {
      leaf.name = node.name;
      leaf.amount = Number(node.amount);
      if (node.unit) leaf.unit = node.unit;
      if (Number(node.metric) > 0) {
        leaf.metric = Number(node.metric);
        if (node.metric_unit) leaf.metric_unit = node.metric_unit;
      }
    }
    return leaf;
  }
  const op = { op: node.op };
  if (node.detail) op.detail = node.detail;
  op.children = node.inputs.map((ref) => treeFor(byId.get(ref), byId, seen));
  return op;
}

/** Convert the validated flat form into the nested shape render_recipe.py consumes. */
export function buildTree(recipe) {
  const out = { title: recipe.title };
  if (recipe.tags && recipe.tags.length) out.tags = recipe.tags;
  if (recipe.deck) out.deck = recipe.deck;
  if (Number(recipe.serves) > 0) out.serves = Number(recipe.serves);
  for (const key of ["yield", "vessel", "oven", "active", "time", "source", "credit"]) {
    if (recipe[key]) out[key] = recipe[key];
  }

  const sections = (recipe.sections || []).map((section) => {
    const byId = new Map();
    for (const node of [...section.ingredients, ...section.steps]) byId.set(node.id, node);
    const referenced = new Set(section.steps.flatMap((s) => s.inputs || []));
    const root = section.steps.find((s) => !referenced.has(s.id));
    const built = { tree: treeFor(root, byId, new Set()) };
    if (section.name) built.name = section.name;
    if (section.prep && section.prep.length) built.prep = section.prep;
    if (section.finish && section.finish.length) built.finish = section.finish;
    return built;
  });

  if (sections.length === 1 && !sections[0].name) {
    Object.assign(out, sections[0]);
  } else {
    out.sections = sections;
  }
  const notes = (recipe.notes || []).filter((note) =>
    typeof note === "string" ? note : note.title || note.body,
  );
  if (notes.length) out.notes = notes;
  return out;
}
