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

const mount = document.getElementById("sheet");
const bar = document.querySelector(".bar");
const params = new URLSearchParams(location.search);

let ticker = null;

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

// --------------------------------------------------------------- the finished table

function showTable(recipe) {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
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
  // after the sheet is in the document. Re-added on each render.
  document.querySelectorAll("script[data-interactive]").forEach((s) => s.remove());
  const script = document.createElement("script");
  script.dataset.interactive = "true";
  script.src = chrome.runtime.getURL("shared/interactive.js");
  document.body.append(script);
}

function showMessage(text) {
  bar.hidden = true;
  const panel = document.createElement("div");
  panel.className = "panel";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  panel.append(p);
  mount.replaceChildren(panel);
}

// ------------------------------------------------------------------ the live run

function showRun(run) {
  bar.hidden = true;

  const panel = document.createElement("div");
  panel.className = "panel";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `${run.provider} · ${run.model}`;

  const heading = document.createElement("h1");
  heading.textContent =
    run.state === "running" ? "Drawing this recipe" : runHeadline(run);

  panel.append(eyebrow, heading);

  if (run.url) {
    const source = document.createElement("p");
    source.className = "source";
    source.textContent = run.url;
    panel.append(source);
  }

  const list = document.createElement("ol");
  list.className = "run-log";
  renderRunLog(list, run);
  panel.append(list);

  if (run.state !== "running") {
    const outcome = document.createElement("p");
    outcome.className = run.state === "error" ? "run-outcome error" : "run-outcome";
    outcome.textContent = runHeadline(run);
    if (run.state === "error") {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = errorDetail(run);
      outcome.append(why);
    }
    panel.append(outcome);
  }

  const row = document.createElement("div");
  row.className = "row";
  if (run.state === "running") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.onclick = () => chrome.runtime.sendMessage({ type: "cancel" });
    row.append(cancel);
  } else if (run.state === "error" || run.state === "cancelled") {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy diagnostics";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(diagnostics(run));
      copy.textContent = "Copied";
    };
    row.append(copy);
  }
  const settings = document.createElement("button");
  settings.type = "button";
  settings.textContent = "Settings";
  settings.onclick = () => chrome.runtime.openOptionsPage();
  row.append(settings);
  panel.append(row);

  mount.replaceChildren(panel);

  // The tab title is what you see when you have switched away from this tab.
  const step = activeStep(run);
  document.title =
    run.state === "running"
      ? `${step ? step.label : "Working"} ${secs(elapsed(run))} — recipe table`
      : `${runHeadline(run)} — recipe table`;

  if (run.state === "running" && !ticker) {
    ticker = setInterval(async () => {
      const stored = await chrome.storage.session.get("run");
      if (stored.run) showRun(stored.run);
    }, 400);
  } else if (run.state !== "running" && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
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
