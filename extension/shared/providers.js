// Provider adapters. Two wire protocols behind one call:
//   - "openai": OpenRouter, OpenAI, and anything else speaking /chat/completions
//               (LM Studio, Ollama, vLLM, a company gateway).
//   - "anthropic": /v1/messages.
//
// Structured output support is uneven across free models, so askForRecipe walks
// a ladder — strict json_schema, then json_object, then prompt-only — and
// remembers per model which rung worked so we stop paying for the 400s.

import { RECIPE_SCHEMA } from "./schema.js";

export const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keysUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-v1-…",
    // OpenRouter publishes a live catalogue; the picker filters it to $0 models.
    canListModels: true,
    note: "Free models are the ones tagged :free. They are rate-limited and vary in quality.",
  },
  anthropic: {
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    defaultModel: "claude-opus-5",
    canListModels: true,
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keysUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    canListModels: true,
  },
  custom: {
    label: "Other OpenAI-compatible",
    kind: "openai",
    baseUrl: "",
    keyHint: "any key the endpoint expects",
    canListModels: true,
    note: "Point this at a gateway or a local server, e.g. http://localhost:11434/v1 for Ollama.",
  },
};

const FREE_PRICE = (model) => {
  const p = model.pricing || {};
  return Number(p.prompt || 0) === 0 && Number(p.completion || 0) === 0;
};

function endpoint(settings, path) {
  const base = (settings.baseUrl || PROVIDERS[settings.provider]?.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("No API base URL configured.");
  return `${base}${path}`;
}

function headers(settings) {
  const provider = PROVIDERS[settings.provider];
  if (provider.kind === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calls made straight from a browser context.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  const h = {
    "content-type": "application/json",
    authorization: `Bearer ${settings.apiKey}`,
  };
  if (settings.provider === "openrouter") {
    h["HTTP-Referer"] = "https://github.com/mikz0rz/ReciTable";
    h["X-Title"] = "ReciTable";
  }
  return h;
}

/**
 * Deadlines, as a mutable object so tests can shorten them.
 * `stall` resets whenever bytes arrive, which is what makes streaming worth it:
 * a model that is thinking keeps the connection warm, a queued one does not.
 */
export const DEADLINES = { stall: 60000, total: 300000 };

function httpError(status, bodyText, json) {
  const detail =
    json?.error?.message ||
    (typeof json?.error === "string" ? json.error : "") ||
    json?.message ||
    bodyText.slice(0, 300) ||
    "no error body";
  let hint = "";
  if (status === 401 || status === 403) hint = " — check the API key.";
  else if (status === 402) hint = " — the account is out of credit.";
  else if (status === 429) hint = " — rate limited. Free models share a small quota; wait or pick another.";
  else if (status === 404) hint = " — that model id may not exist on this provider.";
  else if (status >= 500) hint = " — the provider is having trouble; try again.";
  const err = new Error(`HTTP ${status}: ${detail}${hint}`);
  err.status = status;
  return err;
}

/**
 * fetch with two deadlines: a stall timer that resets whenever bytes arrive, and
 * an overall cap. Without these a queued free model leaves the request pending
 * forever and the caller never learns anything.
 */
async function send(settings, path, body, { signal } = {}) {
  const controller = new AbortController();
  const reason = { why: null };

  // Deadlines are enforced two ways: by aborting the request, and by this
  // promise, which callers race their reads against. Relying on abort alone
  // means a body that ignores its signal can still hang forever.
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = reject;
  });
  aborted.catch(() => {}); // nobody may be racing it; that is fine

  const abort = (why) => {
    if (reason.why) return;
    reason.why = why;
    controller.abort();
    onAbort(describeFailure(new Error("aborted"), reason));
  };

  const total = setTimeout(() => abort("total"), DEADLINES.total);
  let stall = setTimeout(() => abort("stall"), DEADLINES.stall);
  const beat = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort("stall"), DEADLINES.stall);
  };
  const done = () => {
    clearTimeout(total);
    clearTimeout(stall);
  };
  if (signal) {
    if (signal.aborted) abort("cancel");
    signal.addEventListener("abort", () => abort("cancel"), { once: true });
  }

  try {
    const res = await Promise.race([
      fetch(endpoint(settings, path), {
        method: body ? "POST" : "GET",
        headers: headers(settings),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      }),
      aborted,
    ]);
    return { res, beat, done, reason, aborted };
  } catch (err) {
    done();
    throw describeFailure(err, reason);
  }
}

/** Turn an abort or transport failure into something worth showing a person. */
function describeFailure(err, reason) {
  if (reason.why === "stall") {
    return new Error(
      `Nothing arrived for ${DEADLINES.stall / 1000}s. The model is most likely queued or ` +
        "overloaded — try again, or choose another model.",
    );
  }
  if (reason.why === "total") return new Error(`Gave up after ${DEADLINES.total / 1000}s.`);
  if (reason.why === "cancel") {
    const cancelled = new Error("Cancelled.");
    cancelled.cancelled = true;
    return cancelled;
  }
  if (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message)) {
    return new Error(
      "Could not reach the API at all. Check the base URL, your connection, and — for a custom " +
        "endpoint — that the extension has permission for that host.",
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function request(settings, path, body, options) {
  const { res, done, reason, aborted } = await send(settings, path, body, options);
  let text;
  try {
    text = await Promise.race([res.text(), aborted]);
  } catch (err) {
    throw describeFailure(err, reason);
  } finally {
    done();
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the raw text for the error message */
  }
  if (!res.ok) throw httpError(res.status, text, json);
  if (!json) throw new Error(`The provider returned something that is not JSON: ${text.slice(0, 200)}`);
  return json;
}

/** List models the key can use. For OpenRouter, freeOnly filters to $0 pricing. */
export async function listModels(settings, { freeOnly = false } = {}) {
  const json = await request(settings, "/models");
  const raw = json.data || json.models || [];
  let models = raw.map((m) => ({
    id: m.id || m.name,
    label: m.name || m.display_name || m.id,
    free: FREE_PRICE(m),
    context: m.context_length || m.max_input_tokens || null,
  }));
  if (freeOnly) models = models.filter((m) => m.free);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

const lastMeaningful = (chars) => {
  for (let i = chars.length - 1; i >= 0; i--) {
    if (!/\s/.test(chars[i])) return chars[i];
  }
  return "";
};

const nextMeaningful = (text, from) => {
  for (let i = from; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
};

/**
 * Conservative syntax repair for the JSON weak models actually emit: a missing
 * comma between values, a trailing comma before a closing brace, a raw newline
 * inside a string. It only ever touches punctuation and escaping — never content —
 * and reports what it changed. Truncation is deliberately NOT repaired: closing
 * the brackets on a half-written recipe would silently drop ingredients.
 */
export function repairJson(text) {
  const out = [];
  const fixes = new Set();
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out.push(ch);
      } else if (ch === "\\") {
        escaped = true;
        out.push(ch);
      } else if (ch === '"') {
        inString = false;
        out.push(ch);
      } else if (ch === "\n" || ch === "\r") {
        out.push("\\n");
        fixes.add("escaped a newline inside a string");
      } else if (ch === "\t") {
        out.push("\\t");
        fixes.add("escaped a tab inside a string");
      } else {
        out.push(ch);
      }
      continue;
    }

    if (ch === '"' || ch === "{" || ch === "[") {
      const previous = lastMeaningful(out);
      // A value directly after another value is missing its separator.
      if (previous === '"' || previous === "}" || previous === "]" || /[\w]/.test(previous)) {
        out.push(",");
        fixes.add("added a missing comma between values");
      }
      if (ch === '"') inString = true;
      out.push(ch);
      continue;
    }

    if (ch === ",") {
      const following = nextMeaningful(text, i + 1);
      if (following === "}" || following === "]") {
        fixes.add("removed a trailing comma");
        continue;
      }
    }
    out.push(ch);
  }
  return { text: out.join(""), fixes: [...fixes] };
}

/** Where the parser gave up, with enough either side of it to see the problem. */
function around(text, message) {
  const at = Number(/position (\d+)/.exec(message)?.[1]);
  if (!Number.isFinite(at)) return text.slice(0, 200);
  return `…${text.slice(Math.max(0, at - 90), at)}▶HERE◀${text.slice(at, at + 90)}…`;
}

/** Pull the first JSON object out of a response that may be fenced or prefaced with prose. */
export function parseJsonLoosely(text) {
  if (!text) throw new Error("The model returned an empty response.");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    // Fall through to brace matching.
  }

  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in the model's response.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      const region = candidate.slice(start, i + 1);
      try {
        return JSON.parse(region);
      } catch (first) {
        // Balanced but invalid: try the conservative repairs before giving up.
        const { text: mended, fixes } = repairJson(region);
        try {
          const parsed = JSON.parse(mended);
          parsed.__repairs = fixes;
          return parsed;
        } catch {
          const err = new Error(
            `The model's JSON is malformed: ${first.message}. Nothing could be repaired.`,
          );
          err.sample = around(region, first.message);
          throw err;
        }
      }
    }
  }
  throw new Error("The model's JSON response was cut off before it closed.");
}

const FORMAT_MODES = ["json_schema", "json_object", "none"];

function openaiBody(settings, messages, mode, schema = RECIPE_SCHEMA) {
  const body = {
    model: settings.model,
    messages,
    max_tokens: 8000,
  };
  if (mode === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "recipe_table", strict: true, schema },
    };
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

function anthropicBody(settings, messages, mode, schema = RECIPE_SCHEMA) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const body = {
    model: settings.model || PROVIDERS.anthropic.defaultModel,
    // Thinking is on by default on current models and shares this budget with
    // the response, so leave real headroom above the recipe JSON itself.
    max_tokens: 16000,
    system,
    messages: messages.filter((m) => m.role !== "system"),
  };
  if (mode === "json_schema") {
    body.output_config = { format: { type: "json_schema", schema } };
  }
  return body;
}

function readContent(settings, json) {
  if (PROVIDERS[settings.provider].kind === "anthropic") {
    const block = (json.content || []).find((b) => b.type === "text");
    if (!block) throw new Error("The response contained no text block.");
    return block.text;
  }
  const choice = (json.choices || [])[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("The response contained no message content.");
  return Array.isArray(content) ? content.map((c) => c.text || "").join("") : content;
}

/** Pull the text out of one streamed event, whichever protocol produced it. */
function deltaOf(kind, event) {
  if (kind === "anthropic") {
    return event.type === "content_block_delta" ? event.delta?.text || "" : "";
  }
  const choice = event.choices?.[0];
  return choice?.delta?.content || "";
}

function stopOf(kind, event) {
  if (kind === "anthropic") return event.delta?.stop_reason || event.message?.stop_reason || null;
  return event.choices?.[0]?.finish_reason || null;
}

/**
 * Read a Server-Sent Events response, accumulating text and reporting progress.
 *
 * Streaming is not for speed here — it is so a slow model looks alive instead of
 * indistinguishable from a hang, and so the stall deadline only fires when
 * nothing is genuinely happening.
 */
async function streamText(settings, path, body, { signal, onProgress }) {
  const kind = PROVIDERS[settings.provider].kind;
  const { res, beat, done, reason, aborted } = await send(
    settings,
    path,
    { ...body, stream: true },
    { signal },
  );
  let reader = null;
  try {
    if (!res.ok) {
      const text = await Promise.race([res.text(), aborted]);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* raw text is the message */
      }
      throw httpError(res.status, text, json);
    }
    if (!res.body) throw new Error("This endpoint returned no stream to read.");

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stop = null;
    let events = 0;

    for (;;) {
      const { value, done: finished } = await Promise.race([reader.read(), aborted]).catch((err) => {
        throw describeFailure(err, reason);
      });
      if (finished) break;
      beat();
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of block.split("\n")) {
          // Providers send ": keep-alive" comments; the bytes alone do their job.
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          events += 1;
          if (event.error) {
            throw new Error(
              `The provider reported an error mid-stream: ${event.error.message || JSON.stringify(event.error)}`,
            );
          }
          text += deltaOf(kind, event);
          stop = stopOf(kind, event) || stop;
          if (onProgress) onProgress({ chars: text.length, stop });
        }
      }
    }

    if (!events) throw new Error("The stream closed without sending anything usable.");
    return { text, stop };
  } finally {
    done();
    if (reader) reader.cancel().catch(() => {});
  }
}

const FORMAT_ERROR = /response_format|json_schema|schema|output_config|structured|tool/i;
const STREAM_ERROR = /stream|sse|event-stream/i;

function rejectsFormat(err, mode) {
  return (
    mode !== "none" &&
    (err.status === 400 || err.status === 404 || err.status === 422) &&
    FORMAT_ERROR.test(err.message)
  );
}

function rejectsStreaming(err) {
  return (
    (err.status === 400 || err.status === 404 || err.status === 501) && STREAM_ERROR.test(err.message)
  ) || /no stream to read/.test(err.message);
}

/**
 * Send messages, get parsed JSON back.
 *
 * Walks two ladders: the structured-output modes (strict schema, JSON mode,
 * prompt-only) and streaming versus not. Reports which rungs it landed on so the
 * caller can cache them and show them.
 */
export async function complete(
  settings,
  messages,
  { startMode, signal, onProgress, stream = true, schema } = {},
) {
  const kind = PROVIDERS[settings.provider].kind;
  const build = kind === "anthropic" ? anthropicBody : openaiBody;
  const path = kind === "anthropic" ? "/messages" : "/chat/completions";
  const from = startMode ? FORMAT_MODES.indexOf(startMode) : 0;
  const modes = FORMAT_MODES.slice(from === -1 ? 0 : from);
  let lastError = new Error("No attempt was made.");

  const attempt = async (mode, streaming) => {
    const body = build(settings, messages, mode, schema);
    let text;
    let stop = null;
    let usage;
    if (streaming) {
      ({ text, stop } = await streamText(settings, path, body, { signal, onProgress }));
    } else {
      const json = await request(settings, path, body, { signal });
      text = readContent(settings, json);
      stop = json.stop_reason || json.choices?.[0]?.finish_reason || null;
      usage = json.usage;
      if (onProgress) onProgress({ chars: text.length, stop });
    }
    if (stop === "refusal") throw new Error("The model declined this request.");
    if (!text.trim()) {
      throw new Error(
        stop === "length" || stop === "max_tokens"
          ? "The model hit its output limit before writing anything."
          : "The model returned an empty response.",
      );
    }
    if (stop === "length" || stop === "max_tokens") {
      throw new Error(
        "The model ran out of output tokens mid-recipe. Try a model with more headroom.",
      );
    }
    const data = parseJsonLoosely(text);
    const repairs = data.__repairs || [];
    delete data.__repairs;
    return { data, repairs, mode, streamed: streaming, chars: text.length, usage };
  };

  for (const mode of modes) {
    // Anthropic has no json_object mode; for it the ladder is schema then prose.
    if (kind === "anthropic" && mode === "json_object") continue;
    for (const streaming of stream ? [true, false] : [false]) {
      try {
        return await attempt(mode, streaming);
      } catch (caught) {
        const err = caught instanceof Error ? caught : new Error(String(caught));
        lastError = err;
        if (err.cancelled) throw err;
        if (streaming && rejectsStreaming(err)) continue; // same mode, no stream
        if (rejectsFormat(err, mode)) break; // next mode down the ladder
        throw err;
      }
    }
  }
  throw lastError;
}
