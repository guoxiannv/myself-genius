import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import {
  configuredSseBufferMaxBytes,
  createOpenBitfunUsageProxy,
} from "../scripts/openbitfun-usage-proxy.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function jsonResponse(response, status = 200, body = { ok: true }) {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify(body));
}

function completeSse(response, model) {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.end([
    "event: message_start",
    `data: ${JSON.stringify({ type: "message_start", message: { model, usage: { input_tokens: 8 } } })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "fallback response" } })}`,
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"));
}

test("retries a partial SSE stream without leaking the failed provider output", async () => {
  const primaryRequests = [];
  const fallbackRequests = [];
  const primary = http.createServer(async (request, response) => {
    const body = await readJson(request);
    primaryRequests.push(body);
    if (!body.stream) {
      jsonResponse(response);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.write([
      "event: message_start",
      'data: {"type":"message_start","message":{"model":"k3-256k"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"text":"failed partial output"}}',
      "",
    ].join("\n"));
    setTimeout(() => response.destroy(), 5);
  });
  const fallback = http.createServer(async (request, response) => {
    const body = await readJson(request);
    fallbackRequests.push({ body, authorization: request.headers.authorization });
    if (!body.stream) {
      jsonResponse(response);
      return;
    }
    completeSse(response, body.model);
  });

  await listen(primary);
  await listen(fallback);
  const primaryTarget = `http://127.0.0.1:${primary.address().port}`;
  const fallbackTarget = `http://127.0.0.1:${fallback.address().port}`;
  const proxy = createOpenBitfunUsageProxy({
    host: "127.0.0.1",
    port: 0,
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "k3-256k" },
    providers: [
      {
        id: "primary",
        target: primaryTarget,
        authToken: "primary-token",
        models: {},
        tiers: ["opus"],
        quotaCheck: true,
      },
      {
        id: "fallback",
        target: fallbackTarget,
        authToken: "fallback-token",
        models: { opus: "fallback-model" },
        tiers: ["opus"],
        quotaCheck: true,
      },
    ],
    logPath: "/tmp/openbitfun-usage-proxy-partial-sse-test.log",
  });

  try {
    await listen(proxy.server);
    const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "client-token",
      },
      body: JSON.stringify({
        model: "k3-256k",
        stream: true,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(text, /fallback response/);
    assert.doesNotMatch(text, /failed partial output/);
    assert.equal(primaryRequests.filter((request) => request.stream).length, 1);
    assert.equal(fallbackRequests.find((request) => request.body.stream).body.model, "fallback-model");
    assert.equal(fallbackRequests.find((request) => request.body.stream).authorization, "Bearer fallback-token");
  } finally {
    await close(proxy.server);
    await close(primary);
    await close(fallback);
  }
});

test("retries an upstream HTTP 403 with the next provider", async () => {
  const primaryRequests = [];
  const fallbackRequests = [];
  const primary = http.createServer(async (request, response) => {
    const body = await readJson(request);
    primaryRequests.push(body);
    if (!body.stream) {
      jsonResponse(response);
      return;
    }
    jsonResponse(response, 403, { error: { type: "authentication_error", message: "denied" } });
  });
  const fallback = http.createServer(async (request, response) => {
    const body = await readJson(request);
    fallbackRequests.push({ body, authorization: request.headers.authorization });
    if (!body.stream) {
      jsonResponse(response);
      return;
    }
    completeSse(response, body.model);
  });

  await listen(primary);
  await listen(fallback);
  const primaryTarget = `http://127.0.0.1:${primary.address().port}`;
  const fallbackTarget = `http://127.0.0.1:${fallback.address().port}`;
  const proxy = createOpenBitfunUsageProxy({
    host: "127.0.0.1",
    port: 0,
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "k3-256k" },
    providers: [
      {
        id: "primary",
        target: primaryTarget,
        authToken: "primary-token",
        models: {},
        tiers: ["opus"],
        quotaCheck: true,
      },
      {
        id: "fallback",
        target: fallbackTarget,
        authToken: "fallback-token",
        models: { opus: "fallback-model" },
        tiers: ["opus"],
        quotaCheck: true,
      },
    ],
    logPath: "/tmp/openbitfun-usage-proxy-403-test.log",
  });

  try {
    await listen(proxy.server);
    const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "k3-256k",
        stream: true,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /fallback response/);
    assert.equal(primaryRequests.filter((request) => request.stream).length, 1);
    const fallbackRequest = fallbackRequests.find((request) => request.body.stream);
    assert.equal(fallbackRequest.body.model, "fallback-model");
    assert.equal(fallbackRequest.authorization, "Bearer fallback-token");
  } finally {
    await close(proxy.server);
    await close(primary);
    await close(fallback);
  }
});

test("adds the Anthropic version header to provider probes", async () => {
  let probeHeaders;
  const upstream = http.createServer(async (request, response) => {
    const body = await readJson(request);
    if (!body.stream && !probeHeaders) {
      probeHeaders = request.headers;
    }
    jsonResponse(response);
  });
  await listen(upstream);
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createOpenBitfunUsageProxy({
    host: "127.0.0.1",
    port: 0,
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "k3-256k" },
    providers: [{
      id: "probe",
      target,
      authToken: "probe-token",
      models: {},
      tiers: ["opus"],
      quotaCheck: true,
    }],
    logPath: "/tmp/openbitfun-usage-proxy-probe-test.log",
  });

  try {
    await listen(proxy.server);
    const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "k3-256k",
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    await response.text();
    assert.equal(probeHeaders["anthropic-version"], "2023-06-01");
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test("falls back to the default SSE buffer for invalid configuration", () => {
  assert.equal(configuredSseBufferMaxBytes({ OPENBITFUN_PROXY_SSE_BUFFER_MAX_BYTES: "invalid" }), 16 * 1024 * 1024);
  assert.equal(configuredSseBufferMaxBytes({ OPENBITFUN_PROXY_SSE_BUFFER_MAX_BYTES: "0" }), 16 * 1024 * 1024);
  assert.equal(configuredSseBufferMaxBytes({ OPENBITFUN_PROXY_SSE_BUFFER_MAX_BYTES: "4096" }), 4096);
});
