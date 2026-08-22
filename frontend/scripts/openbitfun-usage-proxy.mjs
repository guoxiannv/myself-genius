#!/usr/bin/env node

import http from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { loadOpenBitfunProxyEnv } from "./lib/openbitfun-proxy-env.mjs";
// Claude Code points at this local endpoint. Provider credentials, model
// aliases, and routing policy are loaded from the configured environment file.

const DEFAULT_TARGET = "https://api.openbitfun.com";
const DEFAULT_ZHIPU_TARGET = "https://open.bigmodel.cn/api/anthropic";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 40363;
const DEFAULT_LOG_PATH = resolve(process.cwd(), ".tmp", "openbitfun-usage-proxy.log");
const DEFAULT_BODY_DUMP_DIR = resolve(process.cwd(), ".tmp", "openbitfun-usage-proxy-bodies");
const PATCHED_USAGE_MODELS = new Set([
  "qwen3.7-max",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "glm-5.1",
  "kimi-k2.7-code"
]);

const ROUTER_HEALTH_TTL_MS = 60_000;
const ROUTER_FAILURE_TTL_MS = 5_000;
const ROUTER_STREAM_FAILURE_FREEZE_MS = 30 * 60_000;
const QUOTA_FREEZE_MS = 5 * 60 * 60 * 1000;
const ROUTER_SELECT_ATTEMPTS = 3;
const ROUTER_SELECT_RETRY_DELAY_MS = 500;
const DEFAULT_SSE_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function configuredSseBufferMaxBytes(env = process.env) {
  const value = Number.parseInt(String(env.OPENBITFUN_PROXY_SSE_BUFFER_MAX_BYTES || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SSE_BUFFER_MAX_BYTES;
}


function isAnthropicMessagesPath(pathname) {
  return pathname === "/v1/messages" || pathname === "/messages";
}

function isCountTokensPath(pathname) {
  return pathname === "/v1/messages/count_tokens" || pathname === "/messages/count_tokens";
}

function shouldPatchModel(model) {
  const key = String(model || "").toLowerCase();
  return PATCHED_USAGE_MODELS.has(key) || key === "glm-5.2";
}

export function shouldPatchUsage(req, requestJson) {
  if (req.method !== "POST") {
    return false;
  }
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  return isAnthropicMessagesPath(pathname) && shouldPatchModel(requestJson?.model);
}

function nowIso() {
  return new Date().toISOString();
}

function usageSnapshot(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const usage = value.usage && typeof value.usage === "object" ? value.usage : value;
  if (!usage || typeof usage !== "object" || !Number.isFinite(usage.input_tokens)) {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    claude_cache_creation_1_h_tokens: usage.claude_cache_creation_1_h_tokens ?? 0,
    claude_cache_creation_5_m_tokens: usage.claude_cache_creation_5_m_tokens ?? 0,
    cache_creation: usage.cache_creation && typeof usage.cache_creation === "object"
      ? {
        ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens ?? 0,
        ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens ?? 0,
      }
      : undefined,
  };
}

function errorSnapshot(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    causeName: error?.cause?.name,
    causeMessage: error?.cause?.message,
    causeCode: error?.cause?.code,
    causeErrno: error?.cause?.errno,
    causeSyscall: error?.cause?.syscall,
    causeAddress: error?.cause?.address,
    causePort: error?.cause?.port,
  };
}

function createLogger(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  return (event, data = {}) => {
    const line = JSON.stringify({ ts: nowIso(), event, ...data });
    appendFileSync(logPath, `${line}\n`);
    console.error(line);
  };
}

function createBodyDumper({ enabled = false, dumpDir = DEFAULT_BODY_DUMP_DIR } = {}) {
  if (!enabled) {
    return () => "";
  }
  mkdirSync(dumpDir, { recursive: true });
  return (requestId, body) => {
    if (!body?.length) {
      return "";
    }
    const filePath = resolve(dumpDir, `${requestId}.request.json`);
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch {
      writeFileSync(filePath, body);
    }
    return filePath;
  };
}

export function patchQwenUsage(value) {
  return patchAnthropicUsage(value);
}

export function patchAnthropicUsage(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      patchAnthropicUsage(item);
    }
    return value;
  }

  if (value.usage && typeof value.usage === "object") {
    patchUsageObject(value.usage);
  }
  patchUsageObject(value);

  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      patchAnthropicUsage(item);
    }
  }
  return value;
}

function patchUsageObject(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return;
  }
  if (
    Number.isFinite(usage.input_tokens)
    && (
      Number.isFinite(usage.cache_read_input_tokens)
      || Number.isFinite(usage.cache_creation_input_tokens)
    )
  ) {
    usage.cache_read_input_tokens = 0;
    usage.cache_creation_input_tokens = 0;
    if (usage.cache_creation && typeof usage.cache_creation === "object") {
      usage.cache_creation.ephemeral_1h_input_tokens = 0;
      usage.cache_creation.ephemeral_5m_input_tokens = 0;
    }
    usage.claude_cache_creation_1_h_tokens = 0;
    usage.claude_cache_creation_5_m_tokens = 0;
  }
}

function responseHeaders(upstreamHeaders, { patched = false } = {}) {
  const headers = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    if (patched && (lower === "content-length" || lower === "content-encoding")) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

function requestHeaders(req, { authToken = "" } = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "content-length") {
      continue;
    }
    headers[key] = value;
  }
  headers["accept-encoding"] = "identity";
  if (authToken) {
    headers["x-api-key"] = authToken;
    headers["authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}`, "x-api-key": token } : {};
}

function probeHeaders(authToken = "") {
  return {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    ...authHeaders(authToken),
  };
}

function configuredInitialFrozenRoutes(env = process.env) {
  return String(env.OPENBITFUN_PROXY_INITIAL_FROZEN_ROUTES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuredModelTier(model, env = process.env) {
  const value = String(model || "").trim().toLowerCase();
  if (["opus", "sonnet", "haiku"].includes(value)) {
    return value;
  }
  const aliases = [
    ["opus", env.ROUTER_OPUS_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL],
    ["sonnet", env.ROUTER_SONNET_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL],
    ["haiku", env.ROUTER_HAIKU_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL],
  ];
  return aliases.find(([, alias]) => String(alias || "").trim().toLowerCase() === value)?.[0] || "";
}

function modelForProvider(provider, model, env = process.env) {
  const tier = configuredModelTier(model, env);
  const mapped = tier ? provider.models?.[tier] : "";
  return String(mapped || model || "");
}

function providerSupportsModel(provider, model, env = process.env) {
  const tier = configuredModelTier(model, env);
  return !tier || !Array.isArray(provider.tiers) || provider.tiers.includes(tier);
}

function createProbeRequest(model) {
  return {
    model,
    max_tokens: 1,
    stream: false,
    messages: [{ role: "user", content: "ping" }],
  };
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isKimiModel(model) {
  const value = String(model || "").toLowerCase();
  return value === "k3-256k" || value.startsWith("kimi-");
}

function errorText(body) {
  return [body?.error?.type, body?.error?.code, body?.error?.message, body?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function isSecureProviderTarget(target) {
  try {
    const url = new URL(String(target || ""));
    if (url.protocol === "https:") return true;
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isQuotaExhausted({ providerId = "", model = "", status = 0, body = null } = {}) {
  const text = errorText(body);
  if (isKimiModel(model)) {
    // Never treat a bare 403 as depleted quota: it can also mean a temporary
    // gateway/auth rejection. Freeze only when the response identifies quota.
    return text.includes("exceeded_current_quota_error")
      || /(?:quota|余额|balance).*(?:exceeded|insufficient|耗尽|不足|用完)/.test(text);
  }
  if (String(model || "").toLowerCase().startsWith("deepseek-")) {
    return Number(status) === 402 || text.includes("insufficient balance");
  }
  if (providerId === "zhipu") {
    // Zhipu documents 429 for both rate limiting and depleted balance. Only
    // freeze when its response text explicitly identifies a quota condition.
    return Number(status) === 429 && /(余额|余额不足|余额已用完|insufficient balance|quota.*(?:exceeded|insufficient)|balance.*(?:exhausted|insufficient))/.test(text);
  }
  return false;
}

export function buildDefaultProviders({ target = DEFAULT_TARGET, env = process.env } = {}) {
  const primaryToken = String(env.OPENBITFUN_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || "").trim();
  const csiTarget = String(env.CSITOOL_TARGET || "").trim();
  const csiToken = String(env.CSITOOL_AUTH_TOKEN || "").trim();
  const allowInsecureCsi = env.CSITOOL_ALLOW_INSECURE_HTTP === "1";
  if (csiToken && csiTarget && !isSecureProviderTarget(csiTarget) && !allowInsecureCsi) {
    throw new Error(
      "CSITOOL_TARGET must use HTTPS/a loopback tunnel, or explicitly set CSITOOL_ALLOW_INSECURE_HTTP=1",
    );
  }
  return [
    {
      id: "openbitfun",
      target: env.OPENBITFUN_TARGET || target,
      authToken: primaryToken,
      models: {},
      tiers: ["opus", "sonnet", "haiku"],
      quotaCheck: true,
    },
    {
      id: "zhipu",
      target: env.ZHIPU_TARGET || DEFAULT_ZHIPU_TARGET,
      authToken: String(env.ZHIPU_AUTH_TOKEN || "").trim(),
      models: {
        opus: env.ZHIPU_OPUS_MODEL || "glm-5.2",
        sonnet: env.ZHIPU_SONNET_MODEL || "glm-5.2",
      },
      tiers: ["opus", "sonnet"],
      quotaCheck: true,
    },
    {
      // Keep the Bitfun GLM coding model behind Zhipu: it is an Opus-only
      // third preference, not a replacement for the primary k3-256k route.
      id: "openbitfun-glm",
      target: env.OPENBITFUN_TARGET || target,
      authToken: primaryToken,
      models: { opus: env.BITFUN_OPUS_FALLBACK_MODEL || "glm-5.2" },
      tiers: ["opus"],
      quotaCheck: true,
    },
    {
      id: "csitool",
      target: csiTarget,
      authToken: csiToken,
      models: {
        opus: env.CSITOOL_OPUS_MODEL || "GLM-5.2",
        sonnet: env.CSITOOL_SONNET_MODEL || "GLM-5.2",
        haiku: env.CSITOOL_HAIKU_MODEL || "Qwen3.7-Plus",
      },
      tiers: ["opus", "sonnet", "haiku"],
      quotaCheck: false,
      probeViaMessages: true,
    },
  ].filter((provider) => provider.id === "openbitfun" || (provider.authToken && provider.target));
}

// This is intentionally a dry-run view: it resolves the configured model
// aliases and provider ordering, but never probes or calls an upstream.
export function describeRoutePlan({ providers, env = process.env } = {}) {
  const entries = providers || buildDefaultProviders({ env });
  return ["opus", "sonnet", "haiku"].map((tier) => {
    const requestedModel = String(
      env[`ROUTER_${tier.toUpperCase()}_MODEL`]
        || env[`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`]
        || tier,
    ).trim();
    return {
      tier,
      requestedModel,
      candidates: entries
        .filter((provider) => providerSupportsModel(provider, requestedModel, env))
        .map((provider) => ({
          id: provider.id,
          target: provider.target,
          model: modelForProvider(provider, requestedModel, env),
          credential: provider.authToken ? "configured" : "from-client-or-missing",
        })),
    };
  });
}

function upstreamUrlFor(target, requestPath) {
  const base = new URL(target);
  const request = new URL(requestPath || "/", "http://127.0.0.1");
  const basePath = base.pathname.replace(/\/+$/, "");
  const path = basePath && basePath !== "/" && !request.pathname.startsWith(`${basePath}/`)
    ? `${basePath}${request.pathname}`
    : request.pathname;
  base.pathname = path;
  base.search = request.search;
  return base;
}

export function createProviderRouter({
  providers,
  env = process.env,
  fetchImpl = globalThis.fetch,
  healthTtlMs = ROUTER_HEALTH_TTL_MS,
  failureTtlMs = ROUTER_FAILURE_TTL_MS,
} = {}) {
  const entries = providers || buildDefaultProviders({ env });
  const health = new Map();
  const initialFreezeAt = Date.now();
  for (const healthKey of configuredInitialFrozenRoutes(env)) {
    health.set(healthKey, {
      ok: false,
      status: "operator-frozen",
      checkedAt: initialFreezeAt,
      frozenUntil: initialFreezeAt + ROUTER_STREAM_FAILURE_FREEZE_MS,
    });
  }

  async function probe(provider, requestedModel) {
    const model = modelForProvider(provider, requestedModel, env);
    const probeViaMessages = provider.quotaCheck || provider.probeViaMessages;
    const endpoint = probeViaMessages ? "/v1/messages" : "/health";
    const response = await fetchImpl(upstreamUrlFor(provider.target, endpoint), {
      method: probeViaMessages ? "POST" : "GET",
      headers: probeHeaders(provider.authToken),
      body: probeViaMessages ? JSON.stringify(createProbeRequest(model)) : undefined,
    });
    const body = response.ok ? null : await responseJson(response);
    const quotaExhausted = provider.quotaCheck === true
      && isQuotaExhausted({ providerId: provider.id, model, status: response.status, body });
    return {
      ok: response.ok,
      source: probeViaMessages ? "minimal-model-probe" : "health",
      status: response.status,
      frozenUntil: quotaExhausted ? Date.now() + QUOTA_FREEZE_MS : 0,
    };
  }

  async function select(requestedModel, { forceRefresh = false } = {}) {
    const now = Date.now();
    const failures = [];
    for (const provider of entries) {
      if (!providerSupportsModel(provider, requestedModel, env)) {
        failures.push(`${provider.id}:model-not-configured`);
        continue;
      }
      const model = modelForProvider(provider, requestedModel, env);
      const healthKey = `${provider.id}:${model}`;
      const cached = health.get(healthKey);
      if (cached?.frozenUntil && now < cached.frozenUntil) {
        failures.push(`${provider.id}:frozen`);
        continue;
      }
      const cacheTtlMs = cached?.ok ? healthTtlMs : failureTtlMs;
      if (!forceRefresh && cached && now - cached.checkedAt < cacheTtlMs) {
        if (cached.ok) return { provider, model, probe: cached };
        failures.push(`${provider.id}:${cached.status || "unavailable"}`);
        continue;
      }
      try {
        const result = await probe(provider, requestedModel);
        const cachedResult = { ...result, checkedAt: now };
        health.set(healthKey, cachedResult);
        if (result.ok) return { provider, model, probe: cachedResult };
        failures.push(`${provider.id}:${result.status || "unavailable"}`);
      } catch (error) {
        health.set(healthKey, { ok: false, status: "network-error", checkedAt: now });
        failures.push(`${provider.id}:network-error`);
      }
    }
    const error = new Error(`No usable upstream provider (${failures.join(", ")})`);
    error.failures = failures;
    throw error;
  }

  function markFailed(provider, status, { model = "", body = null, freezeMs = 0 } = {}) {
    // Providers such as CSITOOL are explicitly unlimited and must never be
    // frozen by quota heuristics, regardless of their model name or status.
    const freeze = provider.quotaCheck === true
      && isQuotaExhausted({ providerId: provider.id, model, status, body });
    const healthKey = `${provider.id}:${modelForProvider(provider, model, env)}`;
    health.set(healthKey, {
      ok: false,
      status,
      checkedAt: Date.now(),
      frozenUntil: freeze
        ? Date.now() + QUOTA_FREEZE_MS
        : (freezeMs > 0 ? Date.now() + freezeMs : 0),
    });
  }

  return { select, markFailed, providers: entries, health };
}

function isTransientRouteSelectionError(error) {
  const failures = Array.isArray(error?.failures) ? error.failures : [];
  return failures.some((failure) => /:(?:500|502|503|504|network-error)$/.test(failure));
}

export async function selectProviderWithRetry(
  router,
  requestedModel,
  {
    attempts = ROUTER_SELECT_ATTEMPTS,
    delayMs = ROUTER_SELECT_RETRY_DELAY_MS,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await router.select(requestedModel, { forceRefresh: attempt > 0 });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isTransientRouteSelectionError(error)) {
        throw error;
      }
      await sleepImpl(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(buffer) {
  if (!buffer.length) {
    return null;
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function sanitizeContent(content, { preserveEmpty = false } = {}) {
  if (typeof content === "string") {
    if (content.trim()) {
      return { content, removedTextBlocks: 0, replacedEmptyContent: 0, empty: false };
    }
    return preserveEmpty
      ? { content: "(no output)", removedTextBlocks: 1, replacedEmptyContent: 1, empty: false }
      : { content: null, removedTextBlocks: 1, replacedEmptyContent: 0, empty: true };
  }
  if (!Array.isArray(content)) {
    return { content, removedTextBlocks: 0, replacedEmptyContent: 0, empty: false };
  }

  const blocks = [];
  let removedTextBlocks = 0;
  let replacedEmptyContent = 0;
  for (const block of content) {
    if (
      block
      && typeof block === "object"
      && block.type === "text"
      && (typeof block.text !== "string" || !block.text.trim())
    ) {
      removedTextBlocks += 1;
      continue;
    }
    if (block && typeof block === "object" && block.type === "tool_result" && "content" in block) {
      const nested = sanitizeContent(block.content, { preserveEmpty: true });
      removedTextBlocks += nested.removedTextBlocks;
      replacedEmptyContent += nested.replacedEmptyContent;
      blocks.push({ ...block, content: nested.content });
      continue;
    }
    blocks.push(block);
  }

  if (blocks.length > 0) {
    return { content: blocks, removedTextBlocks, replacedEmptyContent, empty: false };
  }
  return preserveEmpty
    ? {
      content: [{ type: "text", text: "(no output)" }],
      removedTextBlocks,
      replacedEmptyContent: replacedEmptyContent + 1,
      empty: false,
    }
    : { content: null, removedTextBlocks, replacedEmptyContent, empty: true };
}

export function sanitizeAnthropicRequest(requestJson) {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) {
    return {
      request: requestJson,
      removedTextBlocks: 0,
      removedMessages: 0,
      replacedEmptyContent: 0,
    };
  }

  let removedTextBlocks = 0;
  let removedMessages = 0;
  let replacedEmptyContent = 0;
  const request = { ...requestJson };

  if ("system" in request) {
    const system = sanitizeContent(request.system);
    removedTextBlocks += system.removedTextBlocks;
    replacedEmptyContent += system.replacedEmptyContent;
    if (system.empty) {
      delete request.system;
    } else {
      request.system = system.content;
    }
  }

  if (Array.isArray(request.messages)) {
    request.messages = request.messages.flatMap((message) => {
      if (!message || typeof message !== "object" || !("content" in message)) {
        return [message];
      }
      const sanitized = sanitizeContent(message.content);
      removedTextBlocks += sanitized.removedTextBlocks;
      replacedEmptyContent += sanitized.replacedEmptyContent;
      if (sanitized.empty) {
        removedMessages += 1;
        return [];
      }
      return [{ ...message, content: sanitized.content }];
    });
  }

  return { request, removedTextBlocks, removedMessages, replacedEmptyContent };
}

async function handleJsonResponse(upstream, res, log, requestId) {
  const text = await upstream.text();
  let body = text;
  try {
    const parsed = JSON.parse(text);
    const before = usageSnapshot(parsed);
    patchAnthropicUsage(parsed);
    const after = usageSnapshot(parsed);
    if (before || after) {
      log("usage_patched_json", { requestId, before, after });
    }
    body = `${JSON.stringify(parsed)}\n`;
  } catch {
    // If the upstream lied about content-type, pass the original body through.
  }
  res.writeHead(upstream.status, responseHeaders(upstream.headers, { patched: true }));
  res.end(body);
}

function sseEventIsTerminal(event) {
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") {
      return true;
    }
    try {
      if (JSON.parse(payload)?.type === "message_stop") {
        return true;
      }
    } catch {
      // Ignore non-JSON SSE data; the terminal marker is checked separately.
    }
  }
  return false;
}

function streamFailure(message, cause) {
  const error = new Error(message, { cause });
  error.openbitfunUpstreamStreamFailure = true;
  return error;
}

export async function bufferSseResponse(
  upstream,
  log,
  requestId,
  { patchUsage = false, maxBytes = DEFAULT_SSE_BUFFER_MAX_BYTES } = {},
) {
  if (!upstream.body) {
    throw streamFailure("upstream SSE response has no body");
  }
  const decoder = new TextDecoder();
  let pending = "";
  let eventLines = [];
  let buffered = "";
  let bufferedBytes = 0;
  let terminal = false;

  const appendEvent = (event) => {
    if (!event) {
      return;
    }
    const output = patchUsage
      ? event.split(/\r?\n/).map((line) => patchSseLine(line, log, requestId)).join("\n")
      : event;
    bufferedBytes += Buffer.byteLength(output, "utf8") + 2;
    if (bufferedBytes > maxBytes) {
      throw streamFailure(`upstream SSE response exceeded ${maxBytes} byte buffer`);
    }
    buffered += `${output}\n\n`;
    if (sseEventIsTerminal(event)) {
      terminal = true;
    }
  };

  try {
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (line === "") {
          appendEvent(eventLines.join("\n"));
          eventLines = [];
        } else {
          eventLines.push(line);
        }
      }
    }
  } catch (error) {
    throw streamFailure("upstream SSE stream failed before completion", error);
  }

  pending += decoder.decode();
  if (pending) {
    eventLines.push(pending);
  }
  appendEvent(eventLines.join("\n"));
  if (!terminal) {
    throw streamFailure("upstream SSE stream ended before a terminal event");
  }
  return {
    body: Buffer.from(buffered, "utf8"),
    // Events are reconstructed while buffering, so the upstream byte length
    // is no longer authoritative even when usage patching is disabled.
    headers: responseHeaders(upstream.headers, { patched: true }),
  };
}

// A peer may reset a streaming response after headers have been sent.  Do not
// use Readable#pipe here: an unhandled source error terminates the whole Node
// process, turning one upstream failure into ConnectionRefused for everyone.
export async function forwardUpstreamBody(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }
  const source = Readable.fromWeb(upstream.body);
  let downstreamClosed = false;
  const onDownstreamClose = () => {
    downstreamClosed = !res.writableEnded;
  };
  const onUpstreamError = (error) => {
    if (!downstreamClosed) {
      error.openbitfunUpstreamStreamFailure = true;
    }
  };
  res.once("close", onDownstreamClose);
  source.once("error", onUpstreamError);
  try {
    await pipeline(source, res);
  } finally {
    res.removeListener("close", onDownstreamClose);
    source.removeListener("error", onUpstreamError);
  }
}

export function estimateInputTokens(requestJson, body) {
  // Count Tokens is used by Claude Code as a preflight request. OpenBitfun
  // does not implement that endpoint, so return a conservative local estimate
  // rather than forwarding a 404 or involving router health/fallback state.
  const text = typeof requestJson === "object" && requestJson
    ? JSON.stringify(requestJson.messages ?? requestJson)
    : Buffer.from(body || "").toString("utf8");
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function respondCountTokens(res, requestJson, body, log) {
  const inputTokens = estimateInputTokens(requestJson, body);
  log("count_tokens_local", { inputTokens, bodyBytes: body.length });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(`${JSON.stringify({ input_tokens: inputTokens })}\n`);
}

function patchSseLine(line, log = () => {}, requestId = "") {
  if (!line.startsWith("data:")) {
    return line;
  }
  const payload = line.slice(5).trimStart();
  if (!payload || payload === "[DONE]") {
    return line;
  }
  try {
    const parsed = JSON.parse(payload);
    const before = usageSnapshot(parsed);
    patchAnthropicUsage(parsed);
    const after = usageSnapshot(parsed);
    if (before || after) {
      log("usage_patched_sse", { requestId, before, after });
    }
    return `data: ${JSON.stringify(parsed)}`;
  } catch {
    return line;
  }
}

export async function proxyRequest(
  req,
  res,
  { target, router, log, dumpBody, env = process.env, fetchImpl = globalThis.fetch },
) {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, target, providers: router?.providers?.map((provider) => provider.id) || [] }) + "\n");
    return;
  }

  const body = await readRequestBody(req);
  let requestJson = parseJsonBody(body);
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (req.method === "POST" && isCountTokensPath(pathname)) {
    respondCountTokens(res, requestJson, body, log);
    return;
  }
  const sanitized = req.method === "POST" && isAnthropicMessagesPath(pathname)
    ? sanitizeAnthropicRequest(requestJson)
    : {
      request: requestJson,
      removedTextBlocks: 0,
      removedMessages: 0,
      replacedEmptyContent: 0,
    };
  requestJson = sanitized.request;
  const requestedModel = String(requestJson?.model || "");
  const modelTier = configuredModelTier(requestedModel, env);
  const logicalRequestJson = requestJson;
  let selection = await selectProviderWithRetry(router, requestedModel);
  let { provider } = selection;
  let upstreamBody = body;
  let effectiveTarget = provider.target || target;
  let effectiveAuthToken = provider.authToken || "";
  const reqPath = req.url || "/";
  let upstreamUrl = upstreamUrlFor(effectiveTarget, reqPath);
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const requestBodyPath = dumpBody(requestId, body);
  const maxAttempts = Math.max(1, router.providers.length);

  const prepareAttempt = () => {
    if (logicalRequestJson?.model) {
      const attemptRequestJson = { ...logicalRequestJson, model: selection.model };
      upstreamBody = Buffer.from(JSON.stringify(attemptRequestJson), "utf8");
      return attemptRequestJson;
    }
    upstreamBody = body;
    return logicalRequestJson;
  };

  const selectNextProvider = async (previousStatus) => {
    selection = await selectProviderWithRetry(router, requestedModel);
    provider = selection.provider;
    effectiveTarget = provider.target || target;
    effectiveAuthToken = provider.authToken || "";
    upstreamUrl = upstreamUrlFor(effectiveTarget, reqPath);
    prepareAttempt();
    log("upstream_failover", {
      requestId,
      provider: provider.id,
      model: selection.model,
      effectiveTarget,
      previousStatus,
    });
  };

  prepareAttempt();
  if (sanitized.removedTextBlocks || sanitized.removedMessages || sanitized.replacedEmptyContent) {
    log("request_content_sanitized", {
      requestId,
      removedTextBlocks: sanitized.removedTextBlocks,
      removedMessages: sanitized.removedMessages,
      replacedEmptyContent: sanitized.replacedEmptyContent,
    });
  }
  log("request", {
    requestId,
    method: req.method,
    path: upstreamUrl.pathname,
    search: upstreamUrl.search,
    model: selection.model,
    requestedModel,
    tier: modelTier || "custom",
    stream: logicalRequestJson?.stream === true,
    patchUsage: shouldPatchUsage(req, { ...logicalRequestJson, model: selection.model }),
    bodyBytes: upstreamBody.length,
    requestBodyPath,
    effectiveTarget,
    provider: provider.id,
    probe: selection.probe?.source || "",
  });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers: requestHeaders(req, { authToken: effectiveAuthToken }),
        body: upstreamBody.length > 0 ? upstreamBody : undefined,
        redirect: "manual",
      });
    } catch (error) {
      log("upstream_fetch_error", {
        requestId,
        model: selection.model,
        path: upstreamUrl.pathname,
        search: upstreamUrl.search,
        bodyBytes: upstreamBody.length,
        error: errorSnapshot(error),
      });
      router.markFailed(provider, "network-error", { model: selection.model });
      if (attempt >= maxAttempts - 1 || res.destroyed) {
        throw error;
      }
      await selectNextProvider("network-error");
      continue;
    }

    const contentType = upstream.headers.get("content-type") || "";
    const attemptPatchUsage = shouldPatchUsage(req, { ...logicalRequestJson, model: selection.model });
    const retryableStatus = [401, 403, 429, 500, 502, 503, 504].includes(upstream.status);
    log("upstream_response", {
      requestId,
      status: upstream.status,
      contentType,
      patchUsage: attemptPatchUsage,
      provider: provider.id,
      model: selection.model,
    });

    if (retryableStatus && attempt < maxAttempts - 1) {
      const failureBody = await responseJson(upstream.clone());
      router.markFailed(provider, upstream.status, { model: selection.model, body: failureBody });
      await selectNextProvider(upstream.status);
      continue;
    }

    try {
      if (contentType.includes("text/event-stream")) {
        const buffered = await bufferSseResponse(upstream, log, requestId, {
          patchUsage: attemptPatchUsage,
          maxBytes: configuredSseBufferMaxBytes(env),
        });
        res.writeHead(upstream.status, buffered.headers);
        res.end(buffered.body);
      } else if (attemptPatchUsage && contentType.includes("application/json")) {
        await handleJsonResponse(upstream, res, log, requestId);
      } else {
        res.writeHead(upstream.status, responseHeaders(upstream.headers));
        await forwardUpstreamBody(upstream, res);
      }
    } catch (error) {
      if (!error?.openbitfunUpstreamStreamFailure) {
        throw error;
      }
      router.markFailed(provider, "stream-error", {
        model: selection.model,
        freezeMs: ROUTER_STREAM_FAILURE_FREEZE_MS,
      });
      log("upstream_stream_failure", {
        requestId,
        provider: provider.id,
        model: selection.model,
        frozenMs: ROUTER_STREAM_FAILURE_FREEZE_MS,
        error: errorSnapshot(error),
      });
      if (attempt >= maxAttempts - 1 || res.destroyed) {
        throw error;
      }
      await selectNextProvider("stream-error");
      continue;
    }

    log("route_final", {
      requestId,
      tier: modelTier || "custom",
      requestedModel,
      provider: provider.id,
      model: selection.model,
      effectiveTarget,
      status: upstream.status,
      probe: selection.probe?.source || "",
    });
    return;
  }

  throw new Error("proxy exhausted all upstream providers");
}

export function sendProxyErrorResponse(res, error) {
  if (res.writableEnded || res.destroyed) {
    return "ignored";
  }
  if (res.headersSent) {
    res.end();
    return "ended";
  }
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "proxy_error", message: error.message }) + "\n");
  return "json";
}

export function createOpenBitfunUsageProxy({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  target = DEFAULT_TARGET,
  logPath = DEFAULT_LOG_PATH,
  dumpBodies = false,
  bodyDumpDir = DEFAULT_BODY_DUMP_DIR,
  env = process.env,
  fetchImpl = globalThis.fetch,
  providers,
} = {}) {
  const log = createLogger(logPath);
  const dumpBody = createBodyDumper({ enabled: dumpBodies, dumpDir: bodyDumpDir });
  const router = createProviderRouter({ providers: providers || buildDefaultProviders({ target, env }), env, fetchImpl });
  const server = http.createServer((req, res) => {
    proxyRequest(req, res, { target, router, log, dumpBody, env, fetchImpl }).catch((error) => {
      log("proxy_error", { message: error.message, stack: error.stack });
      sendProxyErrorResponse(res, error);
    });
  });
  return { server, host, port, target, logPath, bodyDumpDir, router };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { env, envFile, loaded } = loadOpenBitfunProxyEnv();
  const host = env.OPENBITFUN_PROXY_HOST || DEFAULT_HOST;
  const port = Number.parseInt(env.OPENBITFUN_PROXY_PORT || `${DEFAULT_PORT}`, 10);
  const target = env.OPENBITFUN_PROXY_TARGET || env.OPENBITFUN_TARGET || DEFAULT_TARGET;
  const logPath = env.OPENBITFUN_PROXY_LOG || DEFAULT_LOG_PATH;
  const dumpBodies = env.OPENBITFUN_PROXY_DUMP_BODIES === "1";
  const bodyDumpDir = env.OPENBITFUN_PROXY_BODY_DUMP_DIR || DEFAULT_BODY_DUMP_DIR;
  const { server } = createOpenBitfunUsageProxy({
    host,
    port,
    target,
    logPath,
    dumpBodies,
    bodyDumpDir,
    env,
  });
  server.listen(port, host, () => {
    console.error(`openbitfun usage proxy listening on http://${host}:${port} -> ${target}`);
    console.error(
      loaded
        ? `openbitfun usage proxy env: ${envFile}`
        : `openbitfun usage proxy env not found: ${envFile} (using current shell environment)`,
    );
    console.error(`openbitfun usage proxy log: ${logPath}`);
    if (dumpBodies) {
      console.error(`openbitfun usage proxy request body dumps: ${bodyDumpDir}`);
    }
  });
}
