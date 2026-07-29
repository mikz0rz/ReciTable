// The tab that shows a conversion: first the run as it happens, then the table
// in its place. Being an ordinary tab, it survives switching tabs or applications.

import { renderArticle } from "./shared/layout.js";
import {
  renderRunLog,
  runHeadline,
  errorDetail,
  diagnostics,
  activeStep,
  secs,
  elapsed,
} from "./shared/runlog.js";
import { startKitchen } from "./shared/kitchen.js";

const mount = document.getElementById("sheet");
const bar = document.querySelector(".bar");
const params = new URLSearchParams(location.search);

let ticker = null;
let panel = null; // built once, then painted in place
let kitchen = null;
let latestRun = null; // the ticker must not close over a stale snapshot

function slug(title) {
  return (
    (title || "recipe")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "recipe"
  );
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const asset = (path) => fetch(chrome.runtime.getURL(path)).then((r) => r.text());

async function standaloneHtml(recipe) {
  // Inline the shared stylesheet and script so the saved file works on its own —
  // and matches what render_recipe.py writes from the command line.
  const [css, js] = await Promise.all([
    asset("shared/recipe-table.css"),
    asset("shared/interactive.js"),
  ]);
  const title = recipe.title || "Recipe";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — recipe table</title>
<style>${css}</style>
</head>
<body>
${renderArticle(recipe)}
<script>
${js}</script>
</body>
</html>
`;
}

function teardown() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  latestRun = null;
  if (kitchen) kitchen.stop();
  kitchen = null;
  panel = null;
}

// --------------------------------------------------------- the finished table

function showTable(recipe) {
  teardown();
  try {
    // renderArticle annotates the tree as it lays out, so give it a private copy;
    // Save JSON needs the original untouched.
    mount.innerHTML = renderArticle(structuredClone(recipe));
  } catch (err) {
    return showMessage(`This recipe could not be drawn: ${err.message}`);
  }
  document.title = `${recipe.title || "Recipe"} — recipe table`;
  bar.hidden = false;

  const name = slug(recipe.title);
  document.getElementById("print").onclick = () => window.print();
  document.getElementById("json").onclick = () =>
    download(`${name}.json`, JSON.stringify(recipe, null, 2), "application/json");
  document.getElementById("html").onclick = async () =>
    download(`${name}.html`, await standaloneHtml(structuredClone(recipe)), "text/html");

  // The script builds its controls from the rendered markup, so it has to run
  // after the sheet is in the document.
  document.querySelectorAll("script[data-interactive]").forEach((s) => s.remove());
  const script = document.createElement("script");
  script.dataset.interactive = "true";
  script.src = chrome.runtime.getURL("shared/interactive.js");
  document.body.append(script);
}

function showMessage(text) {
  teardown();
  bar.hidden = true;
  const box = document.createElement("div");
  box.className = "panel";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  box.append(p);
  mount.replaceChildren(box);
}

// -------------------------------------------------------------- the live run

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build the waiting panel once. Rebuilding it on every log write would restart
 * the animation two or three times a second.
 */
function buildPanel(run) {
  const root = el("div", "panel");
  const eyebrow = el("p", "eyebrow", `${run.provider} · ${run.model}`);
  const heading = el("h1", null, "Drawing this recipe");
  const source = el("p", "source", run.url || "");

  const stove = el("pre", "stove");
  stove.setAttribute("aria-hidden", "true"); // decorative; the log is the content
  const caption = el("p", "stove-caption");

  const list = el("ol", "run-log");
  const outcome = el("p", "run-outcome");
  const row = el("div", "row");

  const cancel = el("button", null, "Cancel");
  cancel.type = "button";
  cancel.onclick = () => chrome.runtime.sendMessage({ type: "cancel" });

  const copy = el("button", null, "Copy diagnostics");
  copy.type = "button";

  const settings = el("button", null, "Settings");
  settings.type = "button";
  settings.onclick = () => chrome.runtime.openOptionsPage();

  row.append(cancel, copy, settings);
  root.append(eyebrow, heading, source, stove, caption, list, outcome, row);
  mount.replaceChildren(root);

  kitchen = startKitchen(stove, caption);
  return { root, heading, source, list, outcome, cancel, copy, settings };
}

function paintRun(run) {
  latestRun = run;
  if (!panel) panel = buildPanel(run);
  const { heading, source, list, outcome, cancel, copy } = panel;

  heading.textContent = run.state === "running" ? "Drawing this recipe" : runHeadline(run);
  source.textContent = run.url || "";
  renderRunLog(list, run);

  const step = activeStep(run);
  // The art follows whatever is cooking right now.
  if (kitchen) {
    if (run.state === "error") kitchen.burn();
    else kitchen.show(step ? `${step.label} ${step.detail}` : "");
  }

  outcome.className = run.state === "error" ? "run-outcome error" : "run-outcome";
  outcome.replaceChildren();
  if (run.state !== "running") {
    outcome.textContent = runHeadline(run);
    if (run.state === "error") {
      const why = el("span", "why", errorDetail(run));
      outcome.append(why);
    }
  }

  cancel.hidden = run.state !== "running";
  copy.hidden = run.state === "running";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(diagnostics(run));
    copy.textContent = "Copied";
  };

  // The tab title is what you see once you have switched away from this tab.
  document.title =
    run.state === "running"
      ? `${step ? step.label : "Working"} ${secs(elapsed(run))} — recipe table`
      : `${runHeadline(run)} — recipe table`;

  if (run.state === "running") {
    if (!ticker) {
      // Only to keep the clocks moving; log changes arrive by storage events.
      ticker = setInterval(() => {
        if (!latestRun) return;
        renderRunLog(list, latestRun);
        const live = activeStep(latestRun);
        document.title = `${live ? live.label : "Working"} ${secs(elapsed(latestRun))} — recipe table`;
      }, 400);
    }
  } else {
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (kitchen && run.state !== "error") kitchen.stop();
  }
}

function showRun(run) {
  bar.hidden = true;
  paintRun(run);
}

async function loadRecipe(viewerId) {
  const stored = await chrome.storage.session.get(viewerId);
  return stored[viewerId] || null;
}

async function onRun(run) {
  if (!run) return showMessage("That run is no longer in memory.");
  if (run.state === "done" && run.viewerId) {
    const recipe = await loadRecipe(run.viewerId);
    if (recipe) return showTable(recipe);
  }
  showRun(run);
}

async function init() {
  const recipeId = params.get("id");
  if (recipeId) {
    const recipe = await loadRecipe(recipeId);
    if (!recipe) {
      return showMessage(
        "This recipe is no longer in memory — convert the page again to redraw it.",
      );
    }
    return showTable(recipe);
  }

  const runId = params.get("run");
  if (!runId) return showMessage("No recipe to show.");

  const stored = await chrome.storage.session.get("run");
  // A tab reopened later could be looking at a run that has since been replaced.
  if (stored.run && stored.run.id !== runId && stored.run.state === "running") {
    return showMessage("This tab was watching an older run.");
  }
  await onRun(stored.run);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !changes.run) return;
    const next = changes.run.newValue;
    if (next && next.id === runId) onRun(next);
  });
}

init();
