import { PROVIDERS, listModels, complete } from "./shared/providers.js";

const el = (id) => document.getElementById(id);
const form = el("form");
const providerSelect = el("provider");
const providerNote = el("providerNote");
const baseUrlField = el("baseUrlField");
const baseUrlInput = el("baseUrl");
const apiKeyInput = el("apiKey");
const keyHint = el("keyHint");
const modelSelect = el("model");
const freeOnly = el("freeOnly");
const message = el("message");

let keys = {};

function say(text, { error = false } = {}) {
  message.className = error ? "show error" : "show";
  message.textContent = text;
}

function setModelOptions(models, selected) {
  modelSelect.replaceChildren();
  if (!models.length) {
    const option = new Option("— load models, or type a key first —", "");
    option.disabled = true;
    modelSelect.append(option);
    return;
  }
  for (const model of models) {
    const suffix = model.free ? " (free)" : "";
    modelSelect.append(new Option(`${model.id}${suffix}`, model.id, false, model.id === selected));
  }
  if (selected && !models.some((m) => m.id === selected)) {
    modelSelect.append(new Option(selected, selected, true, true));
  }
}

function applyProvider(provider, { model = "", baseUrl = "" } = {}) {
  const meta = PROVIDERS[provider];
  providerNote.textContent = meta.note || "";
  baseUrlField.hidden = provider !== "custom";
  baseUrlInput.value = baseUrl || (provider === "custom" ? "" : meta.baseUrl);
  apiKeyInput.value = keys[provider] || "";
  apiKeyInput.placeholder = meta.keyHint || "";
  keyHint.replaceChildren();
  if (meta.keysUrl) {
    keyHint.append(document.createTextNode("Get one at "));
    const link = document.createElement("a");
    link.href = meta.keysUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = new URL(meta.keysUrl).host;
    keyHint.append(link);
  }
  freeOnly.closest(".check").hidden = provider !== "openrouter";
  const fallback = model || meta.defaultModel || "";
  setModelOptions(fallback ? [{ id: fallback, free: false }] : [], fallback);
}

function currentSettings() {
  const provider = providerSelect.value;
  return {
    provider,
    apiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
    baseUrl: (baseUrlInput.value.trim() || PROVIDERS[provider].baseUrl).replace(/\/+$/, ""),
    formatModes: {},
  };
}

/** A custom endpoint needs its own host permission before fetch will reach it. */
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    throw new Error("That base URL is not a valid URL.");
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Permission to reach ${origin} was declined.`);
}

el("load").addEventListener("click", async () => {
  const settings = currentSettings();
  if (!settings.apiKey) return say("Enter the API key first.", { error: true });
  say("Loading models…");
  try {
    if (settings.provider === "custom") await ensureHostPermission(settings.baseUrl);
    const models = await listModels(settings, {
      freeOnly: settings.provider === "openrouter" && freeOnly.checked,
    });
    if (!models.length) return say("That key returned no models.", { error: true });
    setModelOptions(models, settings.model);
    say(`${models.length} model${models.length === 1 ? "" : "s"} available.`);
  } catch (err) {
    say(`Could not list models: ${err.message}`, { error: true });
  }
});

el("test").addEventListener("click", async () => {
  const settings = currentSettings();
  if (!settings.apiKey) return say("Enter the API key first.", { error: true });
  if (!settings.model) return say("Pick a model first.", { error: true });
  say("Testing…");
  try {
    if (settings.provider === "custom") await ensureHostPermission(settings.baseUrl);
    const { mode } = await complete(settings, [
      { role: "system", content: 'Reply with the JSON object {"ok": true} and nothing else.' },
      { role: "user", content: "ping" },
    ]);
    const how = {
      json_schema: "with strict JSON schemas",
      json_object: "in JSON mode (no strict schemas)",
      none: "without JSON mode — output is parsed leniently",
    }[mode];
    say(`Works. This model answers ${how}.`);
  } catch (err) {
    say(`Test failed: ${err.message}`, { error: true });
  }
});

providerSelect.addEventListener("change", () => {
  applyProvider(providerSelect.value);
  message.className = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = currentSettings();
  if (!settings.apiKey) return say("Enter the API key first.", { error: true });
  try {
    if (settings.provider === "custom") await ensureHostPermission(settings.baseUrl);
  } catch (err) {
    return say(err.message, { error: true });
  }
  keys = { ...keys, [settings.provider]: settings.apiKey };
  await chrome.storage.local.set({
    provider: settings.provider,
    keys,
    model: settings.model,
    baseUrl: settings.baseUrl,
  });
  say(settings.model ? "Saved." : "Saved — pick a model to start converting.");
});

async function init() {
  for (const [id, meta] of Object.entries(PROVIDERS)) {
    providerSelect.append(new Option(meta.label, id));
  }
  // Opened by the toolbar click because there is nothing configured yet.
  if (new URLSearchParams(location.search).has("setup")) {
    say("Add a key and pick a model. Then click the toolbar icon on any recipe page.");
  }
  const stored = await chrome.storage.local.get(["provider", "keys", "model", "baseUrl"]);
  keys = stored.keys || {};
  const provider = stored.provider || "openrouter";
  providerSelect.value = provider;
  applyProvider(provider, { model: stored.model, baseUrl: stored.baseUrl });
}

init();
