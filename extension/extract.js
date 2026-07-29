// Page-side extraction.
//
// extractRecipe is stringified and injected by chrome.scripting.executeScript, so
// it must be entirely self-contained — no imports, no references to anything in
// this module's scope. Helpers live inside it for that reason.

export function extractRecipe() {
  const ISO_DURATION = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/;

  const humanDuration = (value) => {
    if (typeof value !== "string") return "";
    const m = value.match(ISO_DURATION);
    // Note "0" is a truthy string — compare numerically so PT3H0M is "3 hr".
    const num = (i) => Number(m && m[i] ? m[i] : 0);
    if (!m || (!num(1) && !num(2) && !num(3))) return value;
    const parts = [];
    if (num(1)) parts.push(`${num(1)} day${num(1) === 1 ? "" : "s"}`);
    if (num(2)) parts.push(`${num(2)} hr`);
    if (num(3)) parts.push(`${num(3)} min`);
    return parts.join(" ");
  };

  const asText = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
    if (typeof value === "object") return asText(value.name || value.text || value.value);
    return String(value);
  };

  const flattenInstructions = (value, out = []) => {
    if (value == null) return out;
    if (typeof value === "string") {
      // Some sites cram the whole method into one string with newlines.
      value
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => out.push(s));
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => flattenInstructions(v, out));
      return out;
    }
    if (typeof value === "object") {
      const type = [].concat(value["@type"] || []).join(" ");
      if (/HowToSection/i.test(type)) {
        if (value.name) out.push(`## ${asText(value.name)}`);
        flattenInstructions(value.itemListElement || value.steps, out);
        return out;
      }
      const text = asText(value.text || value.name);
      if (text) out.push(text);
      return out;
    }
    return out;
  };

  const collectJsonLd = () => {
    const objects = [];
    const push = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(push);
        return;
      }
      objects.push(node);
      if (node["@graph"]) push(node["@graph"]);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        push(JSON.parse(script.textContent));
      } catch {
        // Malformed blocks are common; keep going.
      }
    }
    return objects;
  };

  const findRecipe = (objects) =>
    objects.find((o) => [].concat(o["@type"] || []).some((t) => /(^|\/)Recipe$/i.test(String(t))));

  const fromMicrodata = () => {
    const scope = document.querySelector('[itemtype*="schema.org/Recipe" i]');
    if (!scope) return null;
    const prop = (name) => Array.from(scope.querySelectorAll(`[itemprop="${name}"]`));
    const value = (el) =>
      (el.getAttribute("content") || el.getAttribute("datetime") || el.textContent || "").trim();
    const first = (name) => {
      const el = prop(name)[0];
      return el ? value(el) : "";
    };
    const ingredients = prop("recipeIngredient").concat(prop("ingredients")).map(value).filter(Boolean);
    const instructions = prop("recipeInstructions").map(value).filter(Boolean);
    if (!ingredients.length && !instructions.length) return null;
    return {
      name: first("name") || document.title,
      recipeIngredient: ingredients,
      recipeInstructions: instructions,
      recipeYield: first("recipeYield"),
      totalTime: first("totalTime"),
      cookTime: first("cookTime"),
    };
  };

  // Last resort: hand the model readable page text and let it find the recipe.
  const visibleText = () => {
    const clone = document.body.cloneNode(true);
    clone
      .querySelectorAll("script, style, noscript, nav, footer, header, aside, iframe, svg, form")
      .forEach((el) => el.remove());
    return clone.innerText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 16000);
  };

  const raw = findRecipe(collectJsonLd()) || fromMicrodata();
  const result = {
    url: location.href,
    pageTitle: document.title,
    structured: null,
    text: "",
  };

  if (raw) {
    const ingredients = []
      .concat(raw.recipeIngredient || raw.ingredients || [])
      .map(asText)
      .filter(Boolean);
    const steps = flattenInstructions(raw.recipeInstructions);
    if (ingredients.length || steps.length) {
      result.structured = {
        name: asText(raw.name) || document.title,
        ingredients,
        steps,
        yield: asText(raw.recipeYield),
        totalTime: humanDuration(raw.totalTime),
        cookTime: humanDuration(raw.cookTime),
        prepTime: humanDuration(raw.prepTime),
        category: asText(raw.recipeCategory),
        cuisine: asText(raw.recipeCuisine),
      };
    }
  }

  if (!result.structured || !result.structured.ingredients.length || !result.structured.steps.length) {
    result.text = visibleText();
  }
  return result;
}
