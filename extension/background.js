// Orchestration: scrape the tab, ask the model, validate, draw the table.
//
// Started from the dropdown, but run here so it survives the dropdown closing.
// Every step is written to session storage as it happens, and all three views —
// dropdown, the run's own tab, and the toolbar badge — render that one log.

import { extractRecipe } from "./extract.js";
import { complete, PROVIDERS } from "./shared/providers.js";
import { validateRecipe, buildTree } from "./shared/schema.js";
import { SYSTEM_PROMPT, buildUserPrompt, buildRepairPrompt } from "./shared/prompt.js";

const RUN_KEY = "run";

let active = null; // { run, controller, heartbeat }

// -------------------------------------------------------------------- run log

// Writes are chained: each set() serialises a snapshot of the run, so two
// racing writes could otherwise leave an older one last and the tab would
// show state that has already moved on.
let writes = Promise.resolve();

function publish(run) {
  writes = writes.then(() =>
    chrome.storage.session.set({ [RUN_KEY]: run }).catch((err) => {
      console.warn("[recitable] could not write the run log:", err);
    }),
  );
  return writes;
}

function begin(run, key, label) {
  const step = { key, label, detail: "", state: "run", startedAt: Date.now(), ms: 0 };
  run.steps.push(step);
  console.info(`[recitable] ${label}…`);
  publish(run);
  return step;
}

function update(run, step, detail) {
  step.detail = detail;
  step.ms = Date.now() - step.startedAt;
  publish(run);
}

function settle(run, step, detail, state = "ok") {
  step.ms = Date.now() - step.startedAt;
  if (detail) step.detail = detail;
  step.state = state;
  console.info(`[recitable] ${step.label} — ${step.detail} (${step.ms}ms)`);
  publish(run);
}

function fail(run, message, extra = {}) {
  const running = run.steps.find((s) => s.state === "run");
  if (running) {
    running.state = "error";
    running.ms = Date.now() - running.startedAt;
  }
  run.state = "error";
  run.endedAt = Date.now();
  run.error = { message, ...extra };
  console.error("[recitable] failed:", message, extra);
  return publish(run);
}

// Chrome shuts an idle service worker down within about half a minute, which
// would kill a slow request with no trace. Touching an API keeps it awake.
function keepAwake() {
  return setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
}

// ------------------------------------------------------- surfaces you can see
//
// A run in flight is visible three ways: the toolbar badge (from any tab), the
// run's own tab (survives switching away), and a notification when the browser
// itself is in the background.

const BADGE_FRAMES = ["·", "··", "···"];
let badgeTimer = null;

function badge(text, colour) {
  chrome.action.setBadgeText({ text });
  if (colour) chrome.action.setBadgeBackgroundColor({ color: colour });
}

function badgeRunning(run) {
  clearInterval(badgeTimer);
  let frame = 0;
  const paint = () => {
    badge(BADGE_FRAMES[frame++ % BADGE_FRAMES.length], "#1f6b3b");
    const step = run.steps.find((s) => s.state === "run");
    chrome.action.setTitle({
      title: step
        ? `ReciTable — ${step.label}${step.detail ? `: ${step.detail}` : ""}`
        : "ReciTable — working",
    });
  };
  paint();
  badgeTimer = setInterval(paint, 600);
}

function badgeSettled(state) {
  clearInterval(badgeTimer);
  badgeTimer = null;
  if (state === "done") {
    badge("✓", "#1f6b3b");
    chrome.action.setTitle({ title: "ReciTable — done" });
    // Clear the tick after a moment; a failure stays until the next run.
    setTimeout(() => badge(""), 6000);
  } else if (state === "error") {
    badge("!", "#9a2d20");
    chrome.action.setTitle({ title: "ReciTable — failed, click for details" });
  } else {
    badge("");
    chrome.action.setTitle({ title: "Draw this recipe as a table" });
  }
}

/** True when the user is looking at something other than this browser. */
async function browserIsBackground() {
  try {
    const window = await chrome.windows.getLastFocused();
    return !window.focused;
  } catch {
    return false;
  }
}

async function notify(run) {
  if (!chrome.notifications) return;
  if (!(await browserIsBackground())) return; // they can already see the tab
  const done = run.state === "done";
  chrome.notifications.create(`run-${run.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: done ? "ReciTable — your table is ready" : "ReciTable — that one failed",
    message: done
      ? `Drawn in ${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s. Click to open it.`
      : run.error?.message || "Something went wrong.",
    priority: 0,
  });
}

chrome.notifications?.onClicked.addListener(async (id) => {
  const stored = await chrome.storage.session.get(RUN_KEY);
  const run = stored[RUN_KEY];
  chrome.notifications.clear(id);
  if (!run) return;
  if (run.progressTabId) {
    try {
      const tab = await chrome.tabs.get(run.progressTabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      /* the tab is gone; fall through */
    }
  }
  if (run.viewerId) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?id=${run.viewerId}`) });
  }
});

// -------------------------------------------------------------------- helpers

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "provider", "keys", "model", "baseUrl", "formatModes",
  ]);
  const provider = stored.provider || "openrouter";
  return {
    provider,
    apiKey: (stored.keys || {})[provider] || "",
    model: stored.model || PROVIDERS[provider]?.defaultModel || "",
    baseUrl: stored.baseUrl || PROVIDERS[provider]?.baseUrl || "",
    formatModes: stored.formatModes || {},
  };
}

async function rememberModes(settings, mode, streamed) {
  const key = `${settings.provider}:${settings.model}`;
  const current = settings.formatModes[key];
  if (current && current.mode === mode && current.streamed === streamed) return;
  await chrome.storage.local.set({
    formatModes: { ...settings.formatModes, [key]: { mode, streamed } },
  });
}

const kB = (chars) => `${(chars / 1000).toFixed(1)} kB`;

const MODE_LABEL = {
  json_schema: "strict schema",
  json_object: "JSON mode",
  none: "prose, parsed leniently",
};

/** Report bytes as they stream in. Every ask gets one, or it looks frozen. */
function reporter(run, step) {
  let reported = 0;
  return ({ chars }) => {
    // The log is persisted on every write, so only report real movement.
    if (chars - reported < 400) return;
    reported = chars;
    update(run, step, `receiving · ${kB(chars)}`);
  };
}

async function scrape(tabId) {
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractRecipe,
    });
  } catch {
    // Chrome blocks injection on its own pages, the Web Store, and PDFs.
    throw new Error("Chrome does not let extensions read this page. Try it on a recipe page.");
  }
  const extraction = injection?.result;
  if (!extraction || (!extraction.structured && !extraction.text)) {
    throw new Error("Nothing readable found on this page.");
  }
  return extraction;
}

// ------------------------------------------------------------------- the work

async function askModel(run, settings, extraction, signal) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(extraction) },
  ];
  const remembered = settings.formatModes[`${settings.provider}:${settings.model}`];

  const step = begin(run, "model", `Ask ${settings.model}`);
  update(run, step, "waiting for the first bytes");
  const first = await complete(settings, messages, {
    startMode: remembered?.mode,
    stream: remembered ? remembered.streamed !== false : true,
    signal,
    onProgress: reporter(run, step),
  });
  await rememberModes(settings, first.mode, first.streamed);
  settle(
    run,
    step,
    `${MODE_LABEL[first.mode]}${first.streamed ? ", streamed" : ""} · ${kB(first.chars)}`,
  );

  const check = begin(run, "check", "Check the structure");
  let recipe = first.data;
  let result = validateRecipe(recipe);

  if (result.ok) {
    const sections = (recipe.sections || []).length;
    const ingredients = (recipe.sections || []).reduce(
      (n, s) => n + (s.ingredients || []).length,
      0,
    );
    settle(run, check, `${ingredients} ingredients · ${sections} section(s)`);
  } else {
    settle(run, check, `${result.errors.length} problem(s) — ${result.errors[0]}`, "warn");
    const repair = begin(run, "repair", "Ask for a fix");
    update(run, repair, `sent back ${result.errors.length} problem(s)`);
    const repaired = await complete(
      settings,
      [
        ...messages,
        { role: "assistant", content: JSON.stringify(recipe) },
        { role: "user", content: buildRepairPrompt(recipe, result.errors) },
      ],
      {
        startMode: first.mode,
        stream: first.streamed,
        signal,
        onProgress: reporter(run, repair),
      },
    );
    recipe = repaired.data;
    result = validateRecipe(recipe);
    settle(run, repair, result.ok ? "fixed" : "still malformed", result.ok ? "ok" : "error");
  }

  if (!result.ok) {
    const err = new Error(result.errors[0]);
    err.detail = `${result.errors.join("\n")}\nA model that cannot fix this on the second pass usually needs replacing with a stronger one.`;
    throw err;
  }
  if (!recipe.title || !(recipe.sections || []).length) {
    throw new Error("That page does not look like a recipe.");
  }
  return recipe;
}

async function convert(tabId, url) {
  const settings = await loadSettings();
  const run = {
    id: String(Date.now()),
    startedAt: Date.now(),
    state: "running",
    provider: settings.provider,
    model: settings.model,
    url,
    steps: [],
    error: null,
  };
  const controller = new AbortController();
  active = { run, controller, heartbeat: keepAwake() };
  badgeRunning(run);
  await publish(run);

  try {
    if (!settings.apiKey) {
      const err = new Error("No API key set yet.");
      err.needsSetup = true;
      throw err;
    }
    if (!settings.model) {
      const err = new Error("No model chosen yet.");
      err.needsSetup = true;
      throw err;
    }

    // Give the run a tab of its own, opened UNFOCUSED beside the page it came
    // from: you carry on reading the recipe, and the tab is there if you want to
    // watch. It becomes the table in place when the run finishes, so switching
    // tabs or apps never loses sight of it.
    const source = await chrome.tabs.get(tabId).catch(() => null);
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL(`viewer.html?run=${run.id}`),
      active: false,
      openerTabId: source ? source.id : undefined,
      index: source ? source.index + 1 : undefined,
    });
    run.progressTabId = tab.id;
    await publish(run);

    const read = begin(run, "read", "Read the page");
    const extraction = await scrape(tabId);
    settle(
      run,
      read,
      extraction.structured
        ? `structured data · ${extraction.structured.ingredients.length} ingredients, ` +
            `${extraction.structured.steps.length} steps`
        : `no structured data · ${kB(extraction.text.length)} of text`,
    );

    const flat = await askModel(run, settings, extraction, controller.signal);
    flat.source = url || extraction.url;

    const draw = begin(run, "draw", "Draw the table");
    const tree = buildTree(flat);
    const viewerId = `r${Date.now()}`;
    await chrome.storage.session.set({ [viewerId]: tree });
    const operations = (JSON.stringify(tree).match(/"op":/g) || []).length;
    settle(run, draw, `${operations} operations`);

    run.state = "done";
    run.endedAt = Date.now();
    run.viewerId = viewerId;
    await publish(run);
    badgeSettled("done");
    await notify(run);

    // The progress tab has swapped itself for the table; bring it forward now
    // that there is something to look at. Deliberately without focusing its
    // window: if the user has moved to another application, the notification
    // tells them rather than yanking them out of it.
    if (await tabExists(run.progressTabId)) {
      await chrome.tabs.update(run.progressTabId, { active: true });
    } else {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?id=${viewerId}`) });
    }
    return { ok: true };
  } catch (caught) {
    const err = caught instanceof Error ? caught : new Error(String(caught));
    if (err.cancelled) {
      run.state = "cancelled";
      run.endedAt = Date.now();
      const running = run.steps.find((s) => s.state === "run");
      if (running) running.state = "warn";
      await publish(run);
      badgeSettled("cancelled");
      return { ok: false, cancelled: true };
    }
    await fail(run, err.message, {
      detail: err.detail || "",
      status: err.status || null,
      needsSetup: Boolean(err.needsSetup),
    });
    badgeSettled("error");
    await notify(run);
    return { ok: false, error: err.message, needsSetup: Boolean(err.needsSetup) };
  } finally {
    if (active) clearInterval(active.heartbeat);
    active = null;
  }
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * A run still marked "running" with nothing actually running means the worker was
 * restarted underneath it. Say so rather than spinning forever.
 */
async function reconcile() {
  const stored = await chrome.storage.session.get(RUN_KEY);
  const run = stored[RUN_KEY];
  if (!run || run.state !== "running" || active) return;
  await fail(run, "The background worker restarted, so this run was lost. Try again.");
  badgeSettled("error");
}

// The dropdown is the entry point (see popup.js), so chrome.action.onClicked
// never fires and there is no listener for it here.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "convert") {
    // Clicking Convert while one is already in flight would start a competing
    // run against the same log; show the one that exists instead.
    if (active) {
      respond({ ok: false, error: "Already converting a page." });
      return false;
    }
    convert(message.tabId, message.url).then(respond, (caught) =>
      respond({ ok: false, error: caught instanceof Error ? caught.message : String(caught) }),
    );
    return true;
  }
  if (message?.type === "cancel") {
    if (active) active.controller.abort();
    respond({ ok: true, cancelling: Boolean(active) });
    return false;
  }
  if (message?.type === "reconcile") {
    reconcile().then(() => respond({ ok: true }));
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(reconcile);

// This module is evaluated every time the worker starts, including after Chrome
// has shut an idle one down mid-run. Without this, a lost run would sit marked
// "running" with the badge animating for as long as the browser stayed open.
reconcile();
