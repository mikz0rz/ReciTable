// Exercise the request path with a stubbed fetch: streaming, the two ladders
// (structured-output mode and streaming on/off), and every failure that used to
// present as a silent hang.
//
// Usage: node tests/providers.mjs

import { complete, DEADLINES, PROVIDERS } from "../extension/shared/providers.js";

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
  }
};

// Deadlines are short here so the stall test does not take a minute.
DEADLINES.stall = 120;
DEADLINES.total = 2000;

const SETTINGS = {
  provider: "openrouter",
  apiKey: "test",
  model: "some/model:free",
  baseUrl: PROVIDERS.openrouter.baseUrl,
  formatModes: {},
};
const MESSAGES = [{ role: "user", content: "go" }];
const RECIPE = { title: "T", sections: [] };

/** Build an SSE response body out of already-framed event payloads. */
function sse(chunks, { trickle = 0 } = {}) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        if (trickle) await new Promise((r) => setTimeout(r, trickle));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const openaiDelta = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let calls = [];
const stubFetch = (handler) => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers });
    return handler(calls.length, body, init);
  };
};

// ------------------------------------------------------------------ streaming

stubFetch(() =>
  new Response(
    sse([
      openaiDelta('{"title"'),
      openaiDelta(': "Stew", "sections"'),
      openaiDelta(": []}"),
      "data: [DONE]\n\n",
    ]),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ),
);

const seen = [];
const streamed = await complete(SETTINGS, MESSAGES, {
  onProgress: ({ chars }) => seen.push(chars),
});
check("streamed deltas are reassembled into JSON", streamed.data.title === "Stew");
check("the streamed attempt is reported as such", streamed.streamed === true);
check("progress is reported as text arrives", seen.length === 3, JSON.stringify(seen));
check("stream:true is sent", calls[0].body.stream === true);
check(
  "the strict schema is tried first",
  calls[0].body.response_format?.type === "json_schema",
);

// Keep-alive comments and split frames must not break the parser.
stubFetch(() =>
  new Response(
    sse([
      ": OPENROUTER PROCESSING\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"title": "Sp' } }] })}`,
      `\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'lit", "sections": []}' } }] })}\n\n`,
    ]),
    { status: 200 },
  ),
);
const split = await complete(SETTINGS, MESSAGES, {});
check("keep-alive comments and frames split across chunks survive", split.data.title === "Split");

// --------------------------------------------------------------- the ladders

// A model that rejects json_schema but accepts JSON mode.
stubFetch((n, body) => {
  if (body.response_format?.type === "json_schema") {
    return jsonResponse({ error: { message: "response_format json_schema is not supported" } }, 400);
  }
  return new Response(sse([openaiDelta(JSON.stringify(RECIPE))]), { status: 200 });
});
const downgraded = await complete(SETTINGS, MESSAGES, {});
check("a model rejecting strict schemas falls back to JSON mode", downgraded.mode === "json_object");
check("the fallback still streams", downgraded.streamed === true);

// A provider that refuses streaming should be retried without it.
stubFetch((n, body) => {
  if (body.stream) return jsonResponse({ error: { message: "stream is not supported" } }, 400);
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(RECIPE) } }] });
});
const unstreamed = await complete(SETTINGS, MESSAGES, {});
check("a provider refusing to stream is retried without streaming", unstreamed.streamed === false);
check("both attempts were made", calls.length === 2);

// startMode skips rungs already known to fail.
stubFetch(() => new Response(sse([openaiDelta(JSON.stringify(RECIPE))]), { status: 200 }));
await complete(SETTINGS, MESSAGES, { startMode: "json_object" });
check(
  "a remembered mode is used without retrying the rejected one",
  calls[0].body.response_format?.type === "json_object",
);

// ------------------------------------------------------------------- failures

const failsWith = async (handler, options = {}) => {
  stubFetch(handler);
  try {
    await complete(SETTINGS, MESSAGES, options);
    return "(no error thrown)";
  } catch (err) {
    return err instanceof Error ? err.message : `non-Error thrown: ${String(err)}`;
  }
};

// The original hang: a connection that opens and then says nothing.
const stalled = await failsWith(
  () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
);
check(
  "a silent stream fails with a stall message instead of hanging",
  /Nothing arrived for/.test(stalled),
  stalled,
);

const rateLimited = await failsWith(() => jsonResponse({ error: { message: "quota" } }, 429));
check("429 explains the free-model quota", /rate limited/i.test(rateLimited), rateLimited);

const unauthorized = await failsWith(() => jsonResponse({ error: { message: "bad key" } }, 401));
check("401 points at the API key", /check the api key/i.test(unauthorized), unauthorized);

const missingModel = await failsWith(() => jsonResponse({ error: { message: "no such model" } }, 404));
check("404 points at the model id", /model id/i.test(missingModel), missingModel);

const html = await failsWith(() => new Response("<html>gateway</html>", { status: 502 }));
check("a non-JSON error body still produces a status", /HTTP 502/.test(html), html);

const midStream = await failsWith(
  () =>
    new Response(
      sse([openaiDelta("{"), `data: ${JSON.stringify({ error: { message: "upstream died" } })}\n\n`]),
      { status: 200 },
    ),
);
check("an error mid-stream is surfaced", /upstream died/.test(midStream), midStream);

const empty = await failsWith(() => new Response(sse(["data: [DONE]\n\n"]), { status: 200 }));
check("a stream with no content is reported", /without sending anything/.test(empty), empty);

const truncated = await failsWith(
  () =>
    new Response(
      sse([
        openaiDelta('{"title": "x"'),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
      ]),
      { status: 200 },
    ),
);
check("hitting the output limit is named", /ran out of output tokens/.test(truncated), truncated);

const prose = await failsWith(() =>
  new Response(sse([openaiDelta("I can't help with that.")]), { status: 200 }),
);
check("a reply with no JSON in it is reported", /No JSON object/.test(prose), prose);

// The failure seen on a real recipe: structurally balanced but invalid JSON.
const missingComma = await failsWith(() =>
  new Response(sse([openaiDelta('{"a": 1 "b": 2}')]), { status: 200 }),
);
check(
  "a missing comma is repaired rather than reported",
  missingComma === "(no error thrown)",
  missingComma,
);

stubFetch(() => new Response(sse([openaiDelta('{"a": 1 "b": [1, 2,] }')]), { status: 200 }));
const mended = await complete(SETTINGS, MESSAGES, {});
check("the repair fixes both a missing and a trailing comma", mended.data.b.length === 2);
check("the repairs are reported", mended.repairs.length >= 2, JSON.stringify(mended.repairs));

stubFetch(() => new Response(sse([openaiDelta('{"a": "line one\nline two"}')]), { status: 200 }));
const newline = await complete(SETTINGS, MESSAGES, {});
check("a raw newline inside a string is escaped", newline.data.a.includes("\n"));

// Genuinely unfixable: say where it broke and show the text there.
const hopeless = await failsWith(() =>
  new Response(sse([openaiDelta('{"a": @@@ , "b": 2}')]), { status: 200 }),
);
check("unrepairable JSON names its position", /malformed/.test(hopeless), hopeless);

// A repair must never quietly close a truncated recipe.
const cutOff = await failsWith(() =>
  new Response(sse([openaiDelta('{"sections": [{"tree": {"op": "bake"')]), { status: 200 }),
);
check("truncation is reported, not closed up", /cut off/.test(cutOff), cutOff);

// A thrown non-Error used to make the error handler itself throw.
const nonError = await failsWith(() => {
  throw "a bare string";
});
check("a non-Error failure is normalised", /a bare string/.test(nonError), nonError);

// Cancellation should be distinguishable from failure.
stubFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
const controller = new AbortController();
setTimeout(() => controller.abort(), 30);
let cancelled = null;
try {
  await complete(SETTINGS, MESSAGES, { signal: controller.signal });
} catch (err) {
  cancelled = err;
}
check("cancelling is flagged, not reported as an error", cancelled?.cancelled === true, String(cancelled));

// ------------------------------------------------------------------ anthropic

stubFetch(() =>
  new Response(
    sse([
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: '{"title":"A",' } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: '"sections":[]}' } })}\n\n`,
    ]),
    { status: 200 },
  ),
);
const anthropic = await complete(
  { ...SETTINGS, provider: "anthropic", baseUrl: PROVIDERS.anthropic.baseUrl, model: "claude-opus-5" },
  [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
  {},
);
check("anthropic text deltas are reassembled", anthropic.data.title === "A");
check("the system prompt is lifted out of messages", calls[0].body.system === "sys");
check("browser access is declared", Boolean(calls[0].headers["anthropic-dangerous-direct-browser-access"]));
check("the schema goes in output_config", calls[0].body.output_config?.format?.type === "json_schema");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
