// The model's output contract, plus validation and normalisation.
//
// The renderer needs a tree: leaves are ingredients, internal nodes are the
// operations that consume them. An earlier version asked the model for a flat
// graph of ids instead, because JSON Schema cannot express recursion — but a graph
// lets the model produce shapes that are not trees at all (an id consumed twice, a
// cycle, a reference to something that does not exist), and no amount of prompting
// or repair rounds fixed that reliably.
//
// So the schema spells the tree out to a fixed depth instead. There are no ids, and
// an ingredient is written inside the operation that uses it, which makes every one
// of those failures impossible to express rather than merely detectable.

const INGREDIENT = {
  type: "object",
  additionalProperties: false,
  required: ["item", "name", "amount", "unit", "metric", "metric_unit", "note"],
  properties: {
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
    unit: {
      type: "string",
      description: "Unit for amount: 'cups', 'tsp', 'large', 'cans'. \"\" if none.",
    },
    metric: {
      type: "number",
      description:
        "The metric quantity ONLY IF the source states one — 240 for '2 cups (240 g)'. " +
        "0 otherwise. Never convert or estimate it yourself.",
    },
    metric_unit: {
      type: "string",
      description: "'g' or 'mL'. \"\" if there is no metric amount.",
    },
    note: {
      type: "string",
      description:
        "A qualifier: 'room temperature', 'for searing', 'from the cake'. \"\" if none. " +
        "Use it to say which use this is when an ingredient appears more than once.",
    },
  },
};

const OP_FIELDS = {
  op: {
    type: "string",
    description: "One or two lowercase words: 'mix', 'fold in', 'beat', 'melt', 'bake'.",
  },
  detail: {
    type: "string",
    description:
      "Temperature, time, speed, visual cue — 'low speed, until just combined', " +
      "'25-30 min'. Newlines allowed. \"\" if none. Never put the verb here. Include " +
      "the duration whenever the source gives one; the page runs a timer from it.",
  },
};

/** The same shape without the prose. Every level repeats it, and the field
 *  descriptions only need reading once — this keeps the schema a third of the
 *  size it would otherwise be, which matters on a small free-model context. */
function terse(schema) {
  const out = { ...schema, properties: {} };
  delete out.description;
  for (const [key, value] of Object.entries(schema.properties)) {
    out.properties[key] = { type: value.type };
  }
  return out;
}

const TERSE_INGREDIENT = terse(INGREDIENT);

/**
 * An operation whose children may be ingredients or, up to `depth` more levels,
 * further operations. Written out level by level because a `$ref` to itself would
 * be a recursive schema, which structured outputs do not accept.
 */
function operation(depth, top = false) {
  const leaf = top ? INGREDIENT : TERSE_INGREDIENT;
  const child = depth > 0 ? { anyOf: [leaf, operation(depth - 1)] } : leaf;
  return {
    type: "object",
    additionalProperties: false,
    required: ["op", "detail", "children"],
    properties: {
      ...(top
        ? OP_FIELDS
        : { op: { type: "string" }, detail: { type: "string" } }),
      children: {
        type: "array",
        ...(top
          ? {
              description:
                "What this operation combines, in the order the rows should read top to " +
                "bottom: ingredients, and earlier operations whose result goes in here. " +
                "Never empty.",
            }
          : {}),
        items: child,
      },
    },
  };
}

/** Deep enough for any real recipe; the birthday cake below reaches five. */
export const MAX_DEPTH = 6;

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
        "Multi-component recipes (cake + frosting) get one per component plus a final " +
        "assembly section.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "prep", "finish", "tree"],
        properties: {
          name: {
            type: "string",
            description: "Component name, lowercase, e.g. 'frosting'. \"\" if single-component.",
          },
          prep: {
            type: "array",
            description: "Setup that combines nothing: preheating, greasing a pan, resting dough.",
            items: { type: "string" },
          },
          finish: {
            type: "array",
            description:
              "Trailing steps that combine nothing: dividing, cooling, cutting, doneness cues.",
            items: { type: "string" },
          },
          tree: {
            ...operation(MAX_DEPTH - 1, true),
            description:
              "The LAST operation of this component — baking, plating, frosting — with " +
              "everything it needed nested inside it.",
          },
        },
      },
    },
  },
};

// ------------------------------------------------------------------- salvage
//
// Free models routinely get the envelope wrong even under a strict schema, because
// enforcement depends on the provider's backend. Where the recipe content is all
// present and only the wrapper is off, fixing it here is deterministic and invents
// nothing — far better than spending a repair round on it. Anything that would
// require guessing at recipe content is left for validation to reject.

/** Keys a model plausibly reaches for instead of "tree". */
const TREE_KEYS = [
  "tree", "root", "final", "final_step", "operation", "step", "steps",
  "method", "instructions", "process", "stages", "plan",
];

function looksLikeOperation(node) {
  return Boolean(node) && typeof node === "object" && "op" in node && "children" in node;
}

function salvageNode(node) {
  if (Array.isArray(node)) {
    // A single-element array where an object belongs.
    if (node.length === 1) return salvageNode(node[0]);
    return node;
  }
  if (typeof node === "string") return { item: node }; // an ingredient written as a bare string
  if (!node || typeof node !== "object") return node;
  if (!("children" in node)) return node;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  return { ...node, children: children.map(salvageNode) };
}

/**
 * A flat list of operations, in order, instead of a nested one. Chain them: each
 * step's result feeds the next, which is what a linear recipe means anyway. This
 * infers structure from order rather than inventing content, and it is reported.
 */
function chain(steps) {
  const ops = steps.map(salvageNode);
  if (ops.length < 2 || !ops.every(looksLikeOperation)) return null;
  return ops.reduce((previous, step) => ({
    ...step,
    children: [previous, ...(Array.isArray(step.children) ? step.children : [])],
  }));
}

function salvageSection(section) {
  if (!section || typeof section !== "object") return section;
  const out = { ...section };

  // A flat list where the nested root belongs.
  for (const key of TREE_KEYS) {
    if (Array.isArray(out[key])) {
      const chained = chain(out[key]);
      if (chained) {
        out.tree = chained;
        if (key !== "tree") delete out[key];
        break;
      }
    }
  }

  if (!out.tree) {
    // The tree under another name…
    for (const key of TREE_KEYS) {
      if (key !== "tree" && out[key]) {
        const candidate = salvageNode(out[key]);
        if (looksLikeOperation(candidate)) {
          out.tree = candidate;
          delete out[key];
          break;
        }
      }
    }
    // …or the section object is itself the operation.
    if (!out.tree && looksLikeOperation(section)) {
      out.tree = salvageNode({ op: section.op, detail: section.detail || "", children: section.children });
      delete out.op;
      delete out.detail;
      delete out.children;
    }
  } else {
    out.tree = salvageNode(out.tree);
  }
  return out;
}

/** Straighten out a wonky envelope. Returns the recipe and what was repaired. */
export function salvage(recipe) {
  if (!recipe || typeof recipe !== "object") return { recipe, repairs: [] };
  const repairs = [];
  const out = { ...recipe };

  let sections = out.sections;
  if (!Array.isArray(sections)) sections = sections ? [sections] : [];

  // A single-component recipe with the tree hoisted to the top level.
  if (!sections.length) {
    for (const key of TREE_KEYS) {
      const candidate = out[key] && salvageNode(out[key]);
      if (looksLikeOperation(candidate)) {
        sections = [{ name: "", prep: out.prep || [], finish: out.finish || [], tree: candidate }];
        repairs.push(`moved a top-level "${key}" into a section`);
        break;
      }
    }
  }

  out.sections = sections.map((section, i) => {
    const fixed = salvageSection(section);
    if (!looksLikeOperation(section?.tree) && looksLikeOperation(fixed.tree)) {
      const flat = TREE_KEYS.some((k) => Array.isArray(section?.[k]) && section[k].length > 1);
      repairs.push(
        flat
          ? `chained ${section[TREE_KEYS.find((k) => Array.isArray(section[k]))].length} flat steps into a tree in section ${i + 1}`
          : `rebuilt the tree of section ${i + 1} from a differently-shaped field`,
      );
    }
    return fixed;
  });

  return { recipe: out, repairs };
}

// ------------------------------------------------------------------ validation

function isIngredient(node) {
  return node && typeof node === "object" && !("children" in node) && !("op" in node);
}

function walk(node, where, errors, depth, seen) {
  if (!node || typeof node !== "object") {
    errors.push(`${where}: found something that is not an ingredient or an operation.`);
    return;
  }
  if (isIngredient(node)) {
    if (!node.item) errors.push(`${where}: an ingredient has an empty "item".`);
    else seen.count += 1;
    // Rescaling needs the amount and the bare name together; one without the other
    // would be silently dropped rather than half-working.
    if (Number(node.amount) > 0 && !node.name) {
      errors.push(
        `${where}: "${node.item}" gives an amount but no name — set "name" to the ` +
          "ingredient with the quantity stripped.",
      );
    }
    return;
  }
  if (!node.op) errors.push(`${where}: an operation has an empty "op".`);
  const children = node.children;
  if (!Array.isArray(children) || children.length === 0) {
    errors.push(
      `${where}: operation "${node.op || "?"}" has no children. Every operation must ` +
        "combine at least one ingredient or earlier operation.",
    );
    return;
  }
  if (depth > MAX_DEPTH + 2) {
    errors.push(`${where}: the operations are nested deeper than ${MAX_DEPTH + 2} levels.`);
    return;
  }
  for (const child of children) {
    walk(child, `${where} → "${node.op}"`, errors, depth + 1, seen);
  }
}

/** Check the tree. Errors are phrased to be handed back as a repair prompt. */
export function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") return { ok: false, errors: ["Output is not a JSON object."] };
  if (!recipe.title) errors.push("title is empty.");
  const sections = recipe.sections || [];
  if (!sections.length) errors.push("sections is empty — there must be at least one.");

  sections.forEach((section, i) => {
    const where = section.name ? `section "${section.name}"` : `section ${i + 1}`;
    if (!section.tree) {
      errors.push(
        `${where}: has no "tree" — it must hold the component's final operation, an object ` +
          'with "op", "detail" and "children".',
      );
      return;
    }
    if (!("children" in section.tree)) {
      errors.push(
        `${where}: "tree" holds an ingredient, not an operation. It must be the final operation ` +
          'of the component — an object with "op", "detail" and "children" — with the ingredients ' +
          "nested inside it.",
      );
      return;
    }
    const seen = { count: 0 };
    walk(section.tree, where, errors, 1, seen);
    if (!seen.count) errors.push(`${where}: contains no ingredients.`);
  });

  return { ok: errors.length === 0, errors };
}

// --------------------------------------------------------------- normalisation

function cleanNode(node) {
  if (isIngredient(node)) {
    const leaf = { item: node.item };
    if (node.note) leaf.note = node.note;
    // "from" is not part of the wire format any more: a carried-over result is just
    // an ingredient whose note names the component it came from.
    const carried = /^from (.+)/i.exec(node.note || "");
    if (carried) {
      delete leaf.note;
      leaf.from = carried[1];
    }
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
  op.children = node.children.map(cleanNode);
  return op;
}

/** Strip the empty strings and zeros the schema forces, ready for the renderer. */
export function buildTree(recipe) {
  const out = { title: recipe.title };
  if (recipe.tags && recipe.tags.length) out.tags = recipe.tags;
  if (recipe.deck) out.deck = recipe.deck;
  if (Number(recipe.serves) > 0) out.serves = Number(recipe.serves);
  for (const key of ["yield", "vessel", "oven", "active", "time", "source", "credit"]) {
    if (recipe[key]) out[key] = recipe[key];
  }

  const sections = (recipe.sections || []).map((section) => {
    const built = { tree: cleanNode(section.tree) };
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
