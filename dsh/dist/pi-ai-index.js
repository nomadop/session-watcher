//! The code of the DeepSeek Harness plugin @deepseek-ai/dsh-llm-pi-ai bundled in this file is under this license:
//! MIT License
//!
//! Copyright (c) 2026 DeepSeek
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy
//! of this software and associated documentation files (the "Software"), to deal
//! in the Software without restriction, including without limitation the rights
//! to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the Software, and to permit persons to whom the Software is
//! furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in all
//! copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! SOFTWARE.
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// lib/harness/dsh/inner-seal-message.js
var CARRIER_WORDING = {
  addresses: "These summaries stand in for earlier turns of this session; replacing them changed no file and no state, so the work carries on from them. Each summary line below opens with seq numbers: the addresses, in this session's log, of the events it summarizes, which the session history tools can read. A line marked user: holds the user's own words instead, cut where a marker says so.",
  slotLine: (seqs) => `seq ${seqs.join(", ")}: `,
  imageSaved: (name2) => `The image ${name2} is not in the current context; read_image can read the file below when it is needed.`,
  carried: "Evidence carried from the replaced context as of this summary: file text as read from disk when it was written, and skill text as the log recorded it. Each entry changes what the evidence of any earlier summary or kept file excerpt here states. The reads behind this file text still count in this session, so edit a file without reading it again.",
  empty: (path) => `${path} is empty.`,
  unreadable: (path, reason) => `${path} could not be read (${reason}). This is not its text and not a tool failure; read the file directly when it is needed.`,
  skill: (name2, text) => `Skill ${name2}:
${text}`,
  stateHeading: (seq) => `Session state as of session seq ${seq}:`,
  stateLabels: {
    workingDirectory: (tool) => `Working directory, as ${tool} would show:`,
    subagents: (tool) => `Running subagents, as ${tool} would show:`,
    jobs: (tool) => `Running jobs, as ${tool} would show:`,
    todos: (tool) => `Todo list, as ${tool} last left it:`
  },
  stateList: (entries) => entries.map(({ id, label: label2 }) => `${id} \u2014 ${label2}`).join("; "),
  stateUnchanged: "unchanged since the last summary that shows it",
  stateEmpty: "(empty)",
  questionMark: "A line marked question: holds the original question.",
  questionLine: (question) => `question: ${question}`,
  userLine: (user) => `user: ${user}`,
  askCall: ({ id, name: name2, arguments: args }) => `Original ${name2} call ${id}, arguments:
${args}`,
  askResult: (id, { text, isError }) => `Original result of call ${id}${isError ? " (marked as an error)" : ""}:
${text}`
};
var isTodoItem = (item) => item !== null && typeof item === "object" && typeof item.content === "string" && typeof item.status === "string";
function todoItemsOf(value) {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(isTodoItem)) throw new Error("the todo list is neither null nor a list of items with a content text and a status text");
  return value.map(({ content, status }) => ({ content, status }));
}
function textEntriesOf(value, fields, what) {
  if (!Array.isArray(value) || !value.every((entry) => entry !== null && typeof entry === "object" && fields.every((field) => typeof entry[field] === "string"))) {
    throw new Error(`the ${what} is not a list of entries with ${fields.join(" and ")} texts`);
  }
  return value.map((entry) => Object.fromEntries(fields.map((field) => [field, entry[field]])));
}
var sameEntries = (fields, a, b) => a.length === b.length && a.every((entry, at) => fields.every((field) => entry[field] === b[at][field]));
var AGENT_FIELDS = ["id", "label"];
var TODO_FIELDS = ["content", "status"];
var STATE_ITEMS = Object.freeze([
  Object.freeze({
    key: "workingDirectory",
    tool: "working_directory",
    normalize: (value) => {
      if (typeof value !== "string" || value === "") throw new Error("the working directory is not a path text");
      return value;
    },
    isEmpty: () => false,
    same: (a, b) => a === b,
    text: (value) => value
  }),
  Object.freeze({
    key: "subagents",
    tool: "list_agents",
    normalize: (value) => textEntriesOf(value, AGENT_FIELDS, "subagent list"),
    isEmpty: (entries) => entries.length === 0,
    same: (a, b) => sameEntries(AGENT_FIELDS, a, b),
    text: CARRIER_WORDING.stateList
  }),
  Object.freeze({
    key: "jobs",
    tool: "job_list",
    normalize: (value) => textEntriesOf(value, AGENT_FIELDS, "job list"),
    isEmpty: (entries) => entries.length === 0,
    same: (a, b) => sameEntries(AGENT_FIELDS, a, b),
    text: CARRIER_WORDING.stateList
  }),
  Object.freeze({
    key: "todos",
    tool: "todo_write",
    normalize: todoItemsOf,
    isEmpty: (items) => items.length === 0,
    same: (a, b) => sameEntries(TODO_FIELDS, a, b),
    text: (items) => JSON.stringify(items)
  })
]);

// dsh/vendor/dsh-llm-pi-ai/src/config.ts
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";

// dsh/vendor/dsh-llm-pi-ai/src/catalog.ts
import { builtinProviders, getAllBuiltinModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
var NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
var MODALITY_GATE = {
  text: true,
  image: true
};
var MODALITIES = Object.keys(MODALITY_GATE);
function declaredInput(configured) {
  return configured === void 0 || configured.length === 0 ? void 0 : [...configured];
}
var THINKING_LEVEL_GATE = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true
};
var THINKING_LEVELS = Object.keys(THINKING_LEVEL_GATE);
var THINKING_FORMAT_GATE = {
  "openai": true,
  "deepseek": true,
  "openrouter": true,
  "together": true,
  "baseten": true,
  "zai": true,
  "qwen": true,
  "chat-template": true,
  "qwen-chat-template": true,
  "string-thinking": true,
  "ant-ling": true
};
var SUPPORTED_THINKING_FORMATS = Object.keys(THINKING_FORMAT_GATE);
var MAX_TOKENS_FIELD_GATE = {
  max_completion_tokens: true,
  max_tokens: true
};
var MAX_TOKENS_FIELDS = Object.keys(MAX_TOKENS_FIELD_GATE);
var THINKING_TOKEN_BUDGET_FIELD_GATE = {
  thinking_token_budget: true,
  thinking_budget: true,
  thinking_budget_tokens: true
};
var THINKING_TOKEN_BUDGET_FIELDS = Object.keys(THINKING_TOKEN_BUDGET_FIELD_GATE);
var CACHE_CONTROL_FORMAT_GATE = {
  anthropic: true
};
var CACHE_CONTROL_FORMATS = Object.keys(CACHE_CONTROL_FORMAT_GATE);
var CHAT_TEMPLATE_VAR_GATE = {
  "thinking.enabled": true,
  "thinking.effort": true,
  "thinking.budget": true
};
var CHAT_TEMPLATE_VARS = Object.keys(CHAT_TEMPLATE_VAR_GATE);
var providerIndex;
function servesChat(provider) {
  const id = provider.id;
  return getBuiltinModels(id).length > 0 || getAllBuiltinModels(id).length === 0;
}
function catalogProviders() {
  providerIndex ??= new Map(builtinProviders().filter(servesChat).map((provider) => [provider.id, provider]));
  return providerIndex;
}
function catalogProvider(provider) {
  return catalogProviders().get(provider);
}
function catalogProviderIds() {
  return [...catalogProviders().keys()];
}
function catalogModels(provider) {
  if (!catalogProviders().has(provider)) return /* @__PURE__ */ new Map();
  const models = getBuiltinModels(provider);
  return new Map(models.map((model) => [model.id, model]));
}
var COMPLETIONS_COMPAT_GATE = {
  supportsStore: "offer",
  supportsDeveloperRole: "offer",
  supportsReasoningEffort: "offer",
  supportsUsageInStreaming: "offer",
  supportsFinishReason: "offer",
  maxTokensField: "offer",
  requiresToolResultName: "offer",
  requiresAssistantAfterToolResult: "offer",
  requiresThinkingAsText: "offer",
  requiresReasoningContentOnAssistantMessages: "offer",
  thinkingFormat: "offer",
  chatTemplateKwargs: "offer",
  chatTemplateArgs: "offer",
  supportsThinkingTokenBudget: "offer",
  thinkingTokenBudgetField: "offer",
  vllmPriority: "offer",
  supportsStrictMode: "offer",
  cacheControlFormat: "offer",
  supportsLongCacheRetention: "offer",
  openRouterRouting: "withhold",
  vercelGatewayRouting: "withhold",
  zaiToolStream: "withhold",
  supportsOpenAIGrammarTools: "withhold",
  sendSessionAffinityHeaders: "withhold",
  supportsMidConvoSystemMessages: "withhold",
  supportsMidConvoToolAdditions: "withhold",
  sessionAffinityFormat: "withhold"
};
var RESPONSES_COMPAT_GATE = {
  supportsDeveloperRole: "offer",
  supportsMaxOutputTokens: "offer",
  supportsStrictMode: "offer",
  supportsLongCacheRetention: "offer",
  sessionAffinityFormat: "withhold",
  supportsOpenAIGrammarTools: "withhold",
  supportsAdditionalTools: "withhold",
  supportsToolSearch: "withhold",
  supportsExplicitPromptCacheMode: "withhold",
  supportsMidConvoSystemMessages: "withhold",
  supportsMidConvoEffort: "withhold"
};
var OPENAI_RESPONSES_COMPAT_GATE = {
  ...RESPONSES_COMPAT_GATE,
  supportsExplicitPromptCacheMode: "offer"
};
var ANTHROPIC_COMPAT_GATE = {
  supportsEagerToolInputStreaming: "offer",
  supportsLongCacheRetention: "offer",
  supportsCacheControlOnTools: "offer",
  supportsTemperature: "offer",
  forceAdaptiveThinking: "offer",
  allowEmptySignature: "offer",
  supportsStrictTools: "offer",
  sendSessionAffinityHeaders: "withhold",
  sessionAffinityFormat: "withhold",
  supportsMidConvoSystemMessages: "withhold",
  supportsMidConvoToolChanges: "withhold",
  supportsMidConvoEffort: "withhold",
  allowedFallbackModels: "withhold"
};
var BEDROCK_COMPAT_GATE = {
  supportsStrictMode: "offer"
};
var MISTRAL_COMPAT_GATE = {
  supportsMidConvoSystemMessages: "withhold"
};
var COMPAT_GATES = {
  "mistral-conversations": MISTRAL_COMPAT_GATE,
  "openai-completions": COMPLETIONS_COMPAT_GATE,
  "openai-responses": OPENAI_RESPONSES_COMPAT_GATE,
  "azure-openai-responses": RESPONSES_COMPAT_GATE,
  "openai-codex-responses": RESPONSES_COMPAT_GATE,
  "anthropic-messages": ANTHROPIC_COMPAT_GATE,
  "bedrock-converse-stream": BEDROCK_COMPAT_GATE
};
function compatGate(api) {
  return COMPAT_GATES[api];
}
function configuredCompatEntries(compat) {
  return Object.entries(compat ?? {}).flatMap(([field, value]) => {
    const empty = typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
    return empty ? [] : [[field, value]];
  });
}
function compatProtocols(field) {
  return Object.entries(COMPAT_GATES).flatMap(([api, gate]) => gate[field] === "offer" ? [api] : []);
}
function offeredCompatFields(api) {
  return Object.entries(compatGate(api) ?? {}).flatMap(([field, disposition]) => disposition === "offer" ? [field] : []);
}
function allOfferedCompatFields() {
  const fields = /* @__PURE__ */ new Set();
  for (const api of Object.keys(COMPAT_GATES)) {
    for (const field of offeredCompatFields(api)) fields.add(field);
  }
  return [...fields];
}
function assertOfferedCompatFields(provider, site, compat) {
  for (const [field, value] of Object.entries(compat ?? {})) {
    if (compatProtocols(field).length === 0) {
      const declared = Object.values(COMPAT_GATES).some((gate) => gate[field] !== void 0);
      if (declared) {
        invalid(provider, `${site} sets compat "${field}", which is not configurable here: pi-ai's installed catalog sets it for the vendors that need it, so name that provider as the route instead`);
      }
      invalid(provider, `${site} sets compat "${field}", which no wire protocol declares; the configurable switches are ${allOfferedCompatFields().join(", ")}`);
    }
    if (value == null) {
      invalid(provider, `${site} sets compat "${field}" with no value; give it one, or remove the key to leave the field to the next layer \u2014 the installed catalog entry, then pi-ai's own detection`);
    }
  }
}
var PiAiCatalogError = class extends Error {
};
function invalid(provider, detail) {
  throw new PiAiCatalogError(`llm-pi-ai: provider "${provider}" ${detail}`);
}
function sharedCatalogApi(defaults) {
  const apis = /* @__PURE__ */ new Set();
  for (const model of defaults.values()) apis.add(model.api);
  return apis.size === 1 ? [...apis][0] : void 0;
}
function resolveModelReasoning(provider, entry, base) {
  const efforts = entry.reasoningEfforts;
  if (efforts === void 0) {
    return { reasoning: base?.reasoning ?? false };
  }
  if (efforts === false) return { reasoning: false };
  if (efforts === null || Object.keys(efforts).length === 0) {
    invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set false for a non-reasoning model, or omit the field to keep the installed catalog's capability`);
  }
  const declared = THINKING_LEVELS.flatMap((level) => {
    const wire = efforts[level];
    return wire === void 0 ? [] : [[level, wire]];
  });
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== "off") {
        invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch should send; only "off" may leave it empty`);
      }
    } else if (wire.length === 0) {
      invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`);
    }
  }
  if (!declared.some(([level]) => level !== "off")) {
    invalid(provider, `model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking level, or set reasoningEfforts to false for a non-reasoning model`);
  }
  const map = {};
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level];
    if (wire === void 0) {
      map[level] = null;
    } else if (wire !== null) {
      map[level] = wire;
    }
  }
  return { reasoning: true, thinkingLevelMap: map };
}
function resolveModelCompat(provider, entry, route, base, api) {
  const gate = compatGate(api);
  const configured = {};
  for (const [field, value] of configuredCompatEntries(route)) {
    if (gate?.[field] !== "offer") continue;
    configured[field] = value;
  }
  for (const [field, value] of configuredCompatEntries(entry.compat)) {
    if (gate?.[field] !== "offer") {
      const offered = offeredCompatFields(api);
      invalid(provider, `model "${entry.id}" sets compat "${field}", but its api is "${api}", which does not take it; that switch exists on ${compatProtocols(field).join(", ")}, and "${api}" offers ${offered.length === 0 ? "no configurable compat" : offered.join(", ")}`);
    }
    configured[field] = value;
  }
  if (Object.keys(configured).length === 0) return {};
  const inherited = base?.api === api ? base.compat : void 0;
  return { compat: { ...inherited, ...configured } };
}
function resolveRouteModels(request, validation = "strict") {
  const { provider } = request;
  const defaults = catalogModels(provider);
  const providerBaseUrl = catalogProvider(provider)?.baseUrl;
  const configured = request.models ?? [];
  const overrides = request.modelOverrides ?? {};
  const modelErrors = /* @__PURE__ */ new Map();
  for (const [id, override] of Object.entries(overrides)) {
    if (id.length === 0) invalid(provider, "has a modelOverrides entry with an empty model id");
    if (defaults.size === 0) {
      invalid(provider, `sets modelOverrides for "${id}", but the installed catalog does not describe this route; a declared route spells every model out in its models list`);
    }
    if (configured.length > 0) {
      invalid(provider, `sets modelOverrides for "${id}" beside a models list; models already replaces the served catalog, so declare the fields on its entries`);
    }
    if (!defaults.has(id)) {
      const message = `modelOverrides names "${id}", which the installed catalog does not describe`;
      if (validation === "strict") invalid(provider, message);
      modelErrors.set(id, `llm-pi-ai: provider "${provider}" ${message}`);
    }
    if ("id" in override) {
      invalid(provider, `modelOverrides entry "${id}" sets "id", which is the dict key`);
    }
  }
  const entries = configured.length > 0 ? configured : [...defaults.values()].map((model) => ({ id: model.id, ...overrides[model.id] }));
  if (entries.length === 0) {
    invalid(provider, "resolves no models; the installed catalog does not describe this route, so its models must be listed in configuration");
  }
  const routeApi = sharedCatalogApi(defaults);
  assertOfferedCompatFields(provider, "route", request.compat);
  const seen = /* @__PURE__ */ new Set();
  const configuredMaxTokens = /* @__PURE__ */ new Map();
  const resolveEntry = (entry) => {
    assertOfferedCompatFields(provider, `model "${entry.id}"`, entry.compat);
    if (entry.id.length === 0) invalid(provider, "has a model with an empty id");
    if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`);
    seen.add(entry.id);
    const base = defaults.get(entry.id);
    const api = request.api ?? base?.api ?? routeApi;
    if (api === void 0) {
      invalid(provider, `model "${entry.id}" needs an api; the installed catalog does not describe it, so set the route's api to the wire protocol its endpoint speaks`);
    }
    const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl;
    if (baseUrl === void 0) {
      invalid(provider, `model "${entry.id}" needs a baseURL; the installed catalog does not describe this route`);
    }
    const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`);
    }
    const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`);
    }
    if (entry.maxTokens !== void 0) configuredMaxTokens.set(entry.id, entry.maxTokens);
    return {
      // The installed entry lays the floor, and the fields below override it.
      // Enumerating instead would silently drop every `Model` field this
      // package does not model — reasoning-level spellings, compatibility
      // quirks, model headers, and whatever a pi-ai upgrade adds next. Spread,
      // never enumerate.
      ...base,
      id: entry.id,
      name: entry.name ?? base?.name ?? entry.id,
      api,
      provider,
      baseUrl,
      input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput],
      cost: base?.cost ?? NO_COST,
      contextWindow,
      maxTokens,
      ...resolveModelReasoning(provider, entry, base),
      ...resolveModelCompat(provider, entry, request.compat, base, api)
    };
  };
  const models = [];
  for (const entry of entries) {
    let model;
    try {
      model = resolveEntry(entry);
    } catch (error) {
      if (validation === "strict" || !(error instanceof PiAiCatalogError)) throw error;
      modelErrors.set(entry.id, error.message);
      continue;
    }
    models.push(model);
  }
  const serviceableModels = models.filter((model) => !modelErrors.has(model.id));
  for (const [field] of configuredCompatEntries(request.compat)) {
    const takers = compatProtocols(field);
    if (serviceableModels.some((model) => takers.includes(model.api))) continue;
    invalid(provider, `sets compat "${field}", but no model on the route speaks a protocol that takes it; it exists on ${takers.join(", ")}`);
  }
  return { models: serviceableModels, configuredMaxTokens, modelErrors };
}

// dsh/vendor/dsh-llm-pi-ai/src/provider.ts
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

// dsh/vendor/dsh-llm-pi-ai/src/models.ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
function createModels(options) {
  const models = builtinModels(options);
  models.clearProviders();
  return models;
}
function createProvider(input) {
  return {
    id: input.id,
    name: input.name,
    ...input.baseUrl === void 0 ? {} : { baseUrl: input.baseUrl },
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, context, options) => input.api.stream(model, context, options),
    streamSimple: (model, context, options) => input.api.streamSimple(model, context, options)
  };
}

// dsh/vendor/dsh-llm-pi-ai/src/provider.ts
var PROTOCOLS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi
};
function supportedProtocols() {
  return Object.keys(PROTOCOLS);
}
function harnessApiKeyAuth(name2) {
  return {
    name: name2,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
      source: name2
    })
  };
}
function routeAuth(spec, catalog) {
  if (catalog === void 0) return { apiKey: harnessApiKeyAuth(spec.displayName) };
  if (catalog.auth.apiKey !== void 0 || !spec.namesCredential) return catalog.auth;
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) };
}
function reuseCatalogProvider(base, spec) {
  const baseUrl = spec.baseURL ?? base.baseUrl;
  return {
    id: spec.provider,
    name: spec.displayName,
    ...baseUrl === void 0 ? {} : { baseUrl },
    auth: routeAuth(spec, base),
    getModels: () => spec.models,
    // Delegated rather than copied: the catalog provider stays the receiver, so
    // an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options)
  };
}
function buildProvider(spec) {
  const catalog = catalogProvider(spec.provider);
  if (catalog !== void 0 && spec.api === void 0) return reuseCatalogProvider(catalog, spec);
  const factory = spec.api === void 0 ? void 0 : PROTOCOLS[spec.api];
  if (factory === void 0) {
    throw new PiAiCatalogError(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve; supported protocols are ${supportedProtocols().join(", ")}`
    );
  }
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...spec.baseURL === void 0 ? {} : { baseUrl: spec.baseURL },
    auth: routeAuth(spec, catalog),
    models: spec.models,
    api: factory()
  });
}

// dsh/vendor/dsh-llm-pi-ai/src/config.ts
var DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
var DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
var DEFAULT_MAX_REQUEST_IMAGES = 50;
var DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 10;
var DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
var DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
var DEFAULT_CONTEXT_WINDOW = 1e6;
var DEFAULT_MAX_TOKENS = 128e3;
var DEFAULT_INPUT = ["text"];
var thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number()
});
var chatTemplateKwarg = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.const(null),
  z.object({
    $var: z.union(CHAT_TEMPLATE_VARS).required(),
    omitWhenOff: z.boolean()
  })
]);
var compatProfile = z.object({
  supportsStore: z.boolean(),
  supportsDeveloperRole: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportsUsageInStreaming: z.boolean(),
  supportsFinishReason: z.boolean(),
  maxTokensField: z.union(MAX_TOKENS_FIELDS),
  requiresToolResultName: z.boolean(),
  requiresAssistantAfterToolResult: z.boolean(),
  requiresThinkingAsText: z.boolean(),
  requiresReasoningContentOnAssistantMessages: z.boolean(),
  thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
  chatTemplateKwargs: z.dict(chatTemplateKwarg),
  chatTemplateArgs: z.dict(chatTemplateKwarg),
  supportsThinkingTokenBudget: z.boolean(),
  thinkingTokenBudgetField: z.union(THINKING_TOKEN_BUDGET_FIELDS),
  vllmPriority: z.number().step(1),
  supportsMaxOutputTokens: z.boolean(),
  supportsStrictMode: z.boolean(),
  cacheControlFormat: z.union(CACHE_CONTROL_FORMATS),
  supportsLongCacheRetention: z.boolean(),
  supportsExplicitPromptCacheMode: z.boolean(),
  supportsEagerToolInputStreaming: z.boolean(),
  supportsCacheControlOnTools: z.boolean(),
  supportsTemperature: z.boolean(),
  forceAdaptiveThinking: z.boolean(),
  allowEmptySignature: z.boolean(),
  supportsStrictTools: z.boolean()
});
var reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(THINKING_LEVELS)
);
var modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // No explicit default, unlike the route's `defaultInput`: schemastery
  // materializes `[]` for an absent array, and resolution reads that as "no
  // answer here" so the catalog entry below still applies.
  input: z.array(z.union(MODALITIES)),
  // The union, not a bare dict: schemastery materializes an absent dict as
  // `{}`, and absent must stay distinguishable — it means "inherit the
  // installed catalog's capability", while `false` disables reasoning.
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: compatProfile
};
var modelProfile = z.object({
  id: z.string().required(),
  ...modelFields
});
var modelOverride = z.object(modelFields);
var profile = z.object({
  apiKeyEnv: z.string().role("credential-ref"),
  displayName: z.string(),
  api: z.union(supportedProtocols()),
  baseURL: z.string(),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
  compat: compatProfile,
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
  headers: z.dict(z.string()),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets,
  cacheRetention: z.union(["none", "short", "long"]),
  transport: z.union(["sse", "websocket", "websocket-cached", "auto"]),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxRequestImages: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGES),
  imageOffloadCountQuantum: z.number().step(1).min(1),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  retryPolicy: RetryPolicySchema
});
var Config = z.object({
  providers: z.dict(profile).default({}).volatile()
});
function assertServiceable(config, previous) {
  const changed = Object.fromEntries(Object.entries(config.providers ?? {}).filter(([provider, profile2]) => !deepEqualJson(profile2, previous?.providers?.[provider])));
  resolveProfiles(changed);
}
function rejectRemovedFields(provider, source) {
  const legacy = source;
  if ("provider" in legacy) {
    throw new Error(`llm-pi-ai: provider "${provider}" sets "provider", which moved to the providers dict key`);
  }
  if ("maxRetries" in legacy || "maxRetryDelayMs" in legacy) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets maxRetries or maxRetryDelayMs, which were removed; compose agent recovery with dsh-llm-retry`
    );
  }
}
function assertValidHeaders(provider, headers) {
  for (const [name2, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name2, value]]);
    } catch {
      throw new Error(
        `llm-pi-ai: provider "${provider}" header "${name2}" is not valid for Fetch; use a valid HTTP field name and a single-line value representable as bytes`
      );
    }
  }
}
function resolveProfiles(providers, validation = "strict") {
  if (Array.isArray(providers)) {
    throw new Error("llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles");
  }
  const entries = Object.entries(providers ?? {});
  const resolved = /* @__PURE__ */ new Map();
  for (const [provider, source] of entries) {
    rejectRemovedFields(provider, source);
    if (provider.length === 0) throw new Error("llm-pi-ai: provider names must be non-empty");
    if (source.baseURL !== void 0 && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty baseURL`);
    }
    if (source.displayName !== void 0 && source.displayName.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty displayName`);
    }
    assertValidHeaders(provider, source.headers);
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`
      );
    }
    const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
    if (!Number.isInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImageBytes must be a positive integer`);
    }
    const maxRequestImages = source.maxRequestImages ?? DEFAULT_MAX_REQUEST_IMAGES;
    if (!Number.isSafeInteger(maxRequestImages) || maxRequestImages <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImages must be a positive safe integer`);
    }
    const imageOffloadCountQuantum = source.imageOffloadCountQuantum ?? Math.min(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM, maxRequestImages);
    if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0 || imageOffloadCountQuantum > maxRequestImages) {
      throw new Error(`llm-pi-ai: provider "${provider}" imageOffloadCountQuantum must be a positive safe integer no greater than maxRequestImages`);
    }
    const requestImagePixelBudget = source.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET;
    if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImagePixelBudget must be a positive safe integer`);
    }
    const requestImageMaxBytes = source.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES;
    if (!Number.isSafeInteger(requestImageMaxBytes) || requestImageMaxBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImageMaxBytes must be a positive safe integer`);
    }
    const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT];
    if (defaultInput.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" defaultInput must name at least one modality`);
    }
    const displayName = source.displayName ?? provider;
    let catalog;
    let piProvider;
    let catalogError;
    try {
      catalog = resolveRouteModels({
        provider,
        ...source.api === void 0 ? {} : { api: source.api },
        ...source.baseURL === void 0 ? {} : { baseURL: source.baseURL },
        ...source.models === void 0 ? {} : { models: source.models },
        ...source.modelOverrides === void 0 ? {} : { modelOverrides: source.modelOverrides },
        ...source.compat === void 0 ? {} : { compat: source.compat },
        defaultInput,
        defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
      }, validation);
      catalogError = catalog.modelErrors.values().next().value;
      piProvider = buildProvider({
        provider,
        displayName,
        ...source.api === void 0 ? {} : { api: source.api },
        ...source.baseURL === void 0 ? {} : { baseURL: source.baseURL },
        models: catalog.models,
        namesCredential: source.apiKeyEnv !== void 0
      });
    } catch (error) {
      if (validation === "strict" || !(error instanceof PiAiCatalogError)) throw error;
      catalogError ??= error.message;
    }
    const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source;
    resolved.set(provider, {
      ...rest,
      provider,
      displayName,
      ...apiKeyEnv === void 0 ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      maxRequestImageBytes,
      maxRequestImages,
      imageOffloadCountQuantum,
      requestImagePixelBudget,
      requestImageMaxBytes,
      retryPolicy: resolveRetryPolicy(retryPolicy, `llm-pi-ai: provider "${provider}" retryPolicy`),
      ...rest.headers === void 0 ? {} : { headers: { ...rest.headers } },
      ...rest.thinkingBudgets === void 0 ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
      configuredMaxTokens: catalog?.configuredMaxTokens ?? /* @__PURE__ */ new Map(),
      modelErrors: catalog?.modelErrors ?? /* @__PURE__ */ new Map(),
      ...piProvider === void 0 ? {} : { piProvider },
      ...catalogError === void 0 ? {} : { catalogError }
    });
  }
  return resolved;
}

// dsh/vendor/dsh-llm-pi-ai/src/index.ts
import { launchEnvironmentOf as launchEnvironmentOf2 } from "@deepseek-ai/dsh-launch-environment";
import { assertUsableApiKey, LlmError as LlmError3, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { deepEqualJson as deepEqualJson2 } from "@deepseek-ai/dsh-util-values";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";

// dsh/vendor/dsh-llm-pi-ai/src/auth.ts
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  credentialKey,
  credentialKeyId,
  credentialKeyScope,
  credentialRef as credentialRef2,
  isCredentialKeySegment,
  isCredentialRefName
} from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { LlmError } from "@deepseek-ai/dsh-llm";
var RECORD_SCOPE = "llm-pi-ai";
function recordKeyFor(providerId) {
  return credentialKey(RECORD_SCOPE, providerId);
}
function jsonImage(value) {
  if (Array.isArray(value)) return value.map((entry) => entry === void 0 ? null : jsonImage(entry));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== void 0) image[key] = jsonImage(member);
    }
    return image;
  }
  return value;
}
function toPiCredential(record) {
  if (record === void 0) return void 0;
  if (record.kind === "api-key") {
    return {
      type: "api_key",
      ...record.key === void 0 ? {} : { key: record.key },
      ...record.env === void 0 ? {} : { env: { ...record.env } }
    };
  }
  return record.payload;
}
function toRecord(credential) {
  if (credential.type === "api_key") {
    return {
      kind: "api-key",
      ...credential.key === void 0 ? {} : { key: credential.key },
      ...credential.env === void 0 ? {} : { env: { ...credential.env } }
    };
  }
  return { kind: "grant", payload: jsonImage(credential) };
}
function writableStore(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials === void 0) {
    throw new LlmError(
      "llm-pi-ai: this composition mounts no credentials service, so there is nowhere to store the credential a sign-in produces; mount one (dsh-credentials-local) to sign in",
      "NO_CREDENTIAL_STORE"
    );
  }
  return credentials;
}
function credentialStoreFrom(ctx) {
  return {
    async read(providerId) {
      const credentials = ctx.get("credentials");
      if (credentials === void 0) return void 0;
      if (!isCredentialKeySegment(providerId)) return void 0;
      return toPiCredential(await credentials.readRecord(recordKeyFor(providerId)));
    },
    async list() {
      const stored = await ctx.get("credentials")?.listRecords() ?? [];
      const mine = [];
      for (const entry of stored) {
        if (credentialKeyScope(entry.key) !== RECORD_SCOPE) continue;
        mine.push({
          providerId: credentialKeyId(entry.key),
          type: entry.kind === "api-key" ? "api_key" : "oauth"
        });
      }
      return mine;
    },
    async modify(providerId, mutate) {
      if (!isCredentialKeySegment(providerId)) {
        throw new LlmError(
          `llm-pi-ai: provider id "${providerId}" cannot address a stored credential record (a record id is a lowercase hyphenated identifier); authenticate this route through apiKeyEnv instead of a stored credential`,
          "UNSTORABLE_PROVIDER_ID"
        );
      }
      const stored = await writableStore(ctx).modifyRecord(recordKeyFor(providerId), async (current) => {
        const next = await mutate(toPiCredential(current));
        return next === void 0 ? void 0 : toRecord(next);
      });
      return toPiCredential(stored);
    },
    // `async` so a missing service reaches the caller as a rejection: pi-ai's
    // store contract is promise-returning, and a synchronous throw would
    // escape the `ModelsError` wrapper every other storage failure gets.
    async delete(providerId) {
      if (!isCredentialKeySegment(providerId)) return;
      await writableStore(ctx).deleteRecord(recordKeyFor(providerId));
    }
  };
}
function authContextFrom(ctx) {
  return {
    async env(name2) {
      if (isCredentialRefName(name2)) {
        const credentials = ctx.get("credentials");
        const hit = await credentials?.resolve(credentialRef2(name2));
        if (hit !== void 0) return hit.value;
      }
      return launchEnvironmentOf(ctx).get(name2)?.value;
    },
    async fileExists(path) {
      const expanded = path.startsWith("~/") || path === "~" ? resolvePath(homedir(), path.slice(1).replace(/^\//, "")) : path;
      try {
        await access(expanded);
        return true;
      } catch {
        return false;
      }
    }
  };
}

// dsh/vendor/dsh-llm-pi-ai/src/discovery.ts
import { INVALID_CREDENTIAL_CODE, LlmError as LlmError2, normalizeApiKey } from "@deepseek-ai/dsh-llm";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
var LISTABLE_PROTOCOLS = /* @__PURE__ */ new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses"
]);
var ANTHROPIC_VERSION = "2023-06-01";
var ANTHROPIC_MODEL_LIMIT = 1e3;
var MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
function capacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return void 0;
}
function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return void 0;
}
function listingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, "");
  if (api !== "anthropic-messages") return `${base}/models`;
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`;
}
async function readBounded(response, url) {
  const oversized = () => new LlmError2(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, "DISCOVERY_FAILED");
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw oversized();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw oversized();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
function readListing(body) {
  const listing = body;
  const data = listing?.data;
  let listed;
  if (Array.isArray(data)) {
    const rows = data;
    listed = rows.map((raw) => ({ raw }));
  } else {
    const models2 = listing?.models;
    if (models2 === null || typeof models2 !== "object" || Array.isArray(models2)) {
      throw new LlmError2(
        `the endpoint's model listing has neither a "data" array nor a "models" object; enter this provider's models by hand`,
        "DISCOVERY_FAILED"
      );
    }
    listed = Object.entries(models2).filter(([, raw]) => raw !== null && typeof raw === "object" && !Array.isArray(raw)).map(([key, raw]) => ({ key, raw }));
  }
  const models = [];
  for (const { key, raw } of listed) {
    const entry = raw;
    const id = label(key, entry?.id);
    if (id === void 0) continue;
    const name2 = label(entry?.name, entry?.display_name, entry?.displayName) ?? id;
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context
    );
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens
    );
    models.push({
      id,
      name: name2,
      ...contextWindow === void 0 ? {} : { contextWindow },
      ...maxTokens === void 0 ? {} : { maxTokens }
    });
  }
  return models;
}
function usableProbeKey(raw) {
  const checked = normalizeApiKey(raw);
  if (checked.ok) return checked.value;
  throw new LlmError2(
    checked.reason === "empty" ? "this provider's API key is blank; enter it on the Models page, or clear it to probe unauthenticated" : "this provider's API key contains characters no HTTP header can carry; paste the raw key only",
    INVALID_CREDENTIAL_CODE
  );
}
async function discoverModels(request, storedProfile) {
  if (request.provider !== void 0) {
    const installed = catalogModels(request.provider);
    if (installed.size > 0) {
      return [...installed.values()].map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        inputModalities: [...model.input]
      }));
    }
  }
  if (request.baseURL === void 0 || request.baseURL.length === 0) {
    throw new LlmError2(
      `pi-ai ships no catalog for provider "${request.provider ?? ""}", so its models can only come from its endpoint; set a baseURL, or enter this provider's models by hand`,
      "DISCOVERY_FAILED"
    );
  }
  const api = request.api ?? "openai-completions";
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError2(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      "DISCOVERY_UNSUPPORTED"
    );
  }
  const url = listingUrl(request.baseURL, api);
  const stored = storedProfile?.();
  const supplied = request.apiKey ?? await stored?.resolveApiKey();
  const apiKey = supplied === void 0 ? void 0 : usableProbeKey(supplied);
  let response;
  try {
    const headers = new Headers(stored?.headers === void 0 ? void 0 : Object.entries(stored.headers));
    headers.set("accept", "application/json");
    if (api === "anthropic-messages") {
      headers.set("anthropic-version", ANTHROPIC_VERSION);
      if (apiKey !== void 0) headers.set("x-api-key", apiKey);
    } else if (apiKey !== void 0) {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
    for (const [name2, value] of Object.entries(attributionHeaders())) headers.set(name2, value);
    response = await fetch(url, {
      method: "GET",
      headers,
      ...request.signal === void 0 ? {} : { signal: request.signal }
    });
  } catch (error) {
    if (request.signal?.aborted) {
      throw new LlmError2("model discovery aborted by caller", "ABORTED", { cause: error });
    }
    throw new LlmError2(`could not reach ${url}`, "DISCOVERY_FAILED", { cause: error });
  }
  if (!response.ok) {
    throw new LlmError2(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? "; check the API key" : ""}`,
      "DISCOVERY_FAILED"
    );
  }
  let text;
  try {
    text = await readBounded(response, url);
  } catch (error) {
    if (request.signal?.aborted) {
      throw new LlmError2("model discovery aborted by caller", "ABORTED", { cause: error });
    }
    throw error;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new LlmError2(`${url} did not answer with JSON`, "DISCOVERY_FAILED", { cause: error });
  }
  return readListing(body);
}

// dsh/vendor/dsh-llm-pi-ai/src/login.ts
import { isCredentialKeySegment as isCredentialKeySegment2 } from "@deepseek-ai/dsh-credentials";
var UNSERVED_OAUTH = /* @__PURE__ */ new Set(["openai"]);
function loginMethods(provider) {
  const methods = [];
  const oauth = provider === void 0 || UNSERVED_OAUTH.has(provider.id) ? void 0 : provider.auth.oauth;
  if (oauth !== void 0) methods.push({ id: "oauth", label: oauth.loginLabel ?? oauth.name });
  const apiKey = provider?.auth.apiKey;
  if (apiKey?.login !== void 0) methods.push({ id: "api-key", label: apiKey.name });
  return methods;
}
function relay(event, session) {
  switch (event.type) {
    case "info": {
      const link = event.links?.[0];
      session.notify({ message: event.message, ...link === void 0 ? {} : { url: link.url } });
      return;
    }
    case "auth_url":
      session.notify({
        message: event.instructions ?? "Open this page to continue signing in.",
        url: event.url
      });
      return;
    case "device_code":
      session.notify({
        message: "Enter this code on the verification page to finish signing in.",
        url: event.verificationUri,
        code: event.userCode
      });
      return;
    case "progress":
      session.notify({ message: event.message });
      return;
    default:
      session.notify({ message: "Signing in\u2026" });
  }
}
function restate(prompt) {
  const signal = prompt.signal === void 0 ? {} : { signal: prompt.signal };
  switch (prompt.type) {
    case "select":
      return { ...signal, kind: "select", message: prompt.message, options: prompt.options };
    case "secret":
      return {
        ...signal,
        kind: "secret",
        message: prompt.message,
        ...prompt.placeholder === void 0 ? {} : { placeholder: prompt.placeholder }
      };
    default:
      return {
        ...signal,
        kind: "text",
        message: prompt.message,
        ...prompt.placeholder === void 0 ? {} : { placeholder: prompt.placeholder }
      };
  }
}
function registerPiAiFlows(ctx, auth) {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId);
    const [first, ...rest] = loginMethods(provider);
    if (provider === void 0 || first === void 0) continue;
    if (!isCredentialKeySegment2(providerId)) {
      ctx.logger.warn(
        'llm-pi-ai: catalog provider "%s" cannot address a credential record; its sign-in is not offered',
        providerId
      );
      continue;
    }
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId),
      label: provider.name,
      methods: [first, ...rest],
      async run(session) {
        const models = createModels(auth);
        models.setProvider(provider);
        const type = session.method === "oauth" ? "oauth" : "api_key";
        await models.login(providerId, type, {
          signal: session.signal,
          notify: (event) => {
            relay(event, session);
          },
          prompt: (prompt) => session.prompt(restate(prompt))
        });
      }
    });
  }
}

// dsh/vendor/dsh-llm-pi-ai/src/provider-data.generated.ts
var PROVIDER_DATA = {
  "amazon-bedrock": { env: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE"], baseURLEnv: ["AWS_REGION", "AWS_DEFAULT_REGION"] },
  "ant-ling": { env: ["ANT_LING_API_KEY"], defaultBaseURL: "https://api.ant-ling.com/v1" },
  "anthropic": { env: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID"], defaultBaseURL: "https://api.anthropic.com" },
  "azure": { env: ["AZURE_OPENAI_API_KEY"], baseURLEnv: ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME"] },
  "baseten": { env: ["BASETEN_API_KEY"], defaultBaseURL: "https://inference.baseten.co/v1" },
  "cerebras": { env: ["CEREBRAS_API_KEY"], defaultBaseURL: "https://api.cerebras.ai/v1" },
  "cloudflare-ai-gateway": { env: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"], baseURLEnv: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"] },
  "cloudflare-workers-ai": { env: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"], baseURLEnv: ["CLOUDFLARE_ACCOUNT_ID"] },
  "deepseek": { env: ["DEEPSEEK_API_KEY"], defaultBaseURL: "https://api.deepseek.com" },
  "fireworks": { env: ["FIREWORKS_API_KEY"], defaultBaseURL: "https://api.fireworks.ai/inference" },
  "github-copilot": { env: ["COPILOT_GITHUB_TOKEN"], defaultBaseURL: "https://api.individual.githubcopilot.com" },
  "google": { env: ["GEMINI_API_KEY"], defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta" },
  "google-vertex": { env: ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"], baseURLEnv: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"] },
  "groq": { env: ["GROQ_API_KEY"], defaultBaseURL: "https://api.groq.com/openai/v1" },
  "huggingface": { env: ["HF_TOKEN"], defaultBaseURL: "https://router.huggingface.co/v1" },
  "kimi-coding": { env: ["KIMI_API_KEY"], defaultBaseURL: "https://api.kimi.com/coding/v1" },
  "meta": { env: ["META_API_KEY"], defaultBaseURL: "https://api.meta.ai/v1" },
  "minimax": { env: ["MINIMAX_API_KEY"], defaultBaseURL: "https://api.minimax.io/anthropic" },
  "minimax-cn": { env: ["MINIMAX_CN_API_KEY"], defaultBaseURL: "https://api.minimaxi.com/anthropic" },
  "mistral": { env: ["MISTRAL_API_KEY"], defaultBaseURL: "https://api.mistral.ai" },
  "moonshotai": { env: ["MOONSHOT_API_KEY"], defaultBaseURL: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { env: ["MOONSHOT_API_KEY"], defaultBaseURL: "https://api.moonshot.cn/v1" },
  "nvidia": { env: ["NVIDIA_API_KEY"], defaultBaseURL: "https://integrate.api.nvidia.com/v1" },
  "openai": { env: ["OPENAI_API_KEY"], defaultBaseURL: "https://api.openai.com/v1" },
  "openai-codex": { env: [], defaultBaseURL: "https://chatgpt.com/backend-api" },
  "opencode": { env: ["OPENCODE_API_KEY"] },
  "opencode-go": { env: ["OPENCODE_API_KEY"] },
  "openrouter": { env: ["OPENROUTER_API_KEY"], defaultBaseURL: "https://openrouter.ai/api/v1" },
  "qwen-token-plan": { env: ["QWEN_TOKEN_PLAN_API_KEY"], defaultBaseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  "qwen-token-plan-cn": { env: ["QWEN_TOKEN_PLAN_CN_API_KEY"], defaultBaseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
  "qwen-token-plan-individual": { env: ["QWEN_TOKEN_PLAN_API_KEY"], defaultBaseURL: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  "radius": { env: ["RADIUS_API_KEY"], defaultBaseURL: "https://radius.pi.dev/v1" },
  "together": { env: ["TOGETHER_API_KEY"], defaultBaseURL: "https://api.together.ai/v1" },
  "typesafe": { env: ["TYPESAFE_API_KEY"] },
  "vercel-ai-gateway": { env: ["AI_GATEWAY_API_KEY"], defaultBaseURL: "https://ai-gateway.vercel.sh" },
  "xai": { env: ["XAI_API_KEY"], defaultBaseURL: "https://api.x.ai/v1" },
  "xiaomi": { env: ["XIAOMI_API_KEY"], defaultBaseURL: "https://api.xiaomimimo.com/v1" },
  "xiaomi-token-plan-ams": { env: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], defaultBaseURL: "https://token-plan-ams.xiaomimimo.com/v1" },
  "xiaomi-token-plan-cn": { env: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], defaultBaseURL: "https://token-plan-cn.xiaomimimo.com/v1" },
  "xiaomi-token-plan-sgp": { env: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"], defaultBaseURL: "https://token-plan-sgp.xiaomimimo.com/v1" },
  "zai": { env: ["ZAI_API_KEY"], defaultBaseURL: "https://api.z.ai/api/coding/paas/v4" },
  "zai-coding-cn": { env: ["ZAI_CODING_CN_API_KEY"], defaultBaseURL: "https://open.bigmodel.cn/api/coding/paas/v4" }
};

// dsh/vendor/dsh-llm-pi-ai/src/provider-data.ts
function providerDefaultsOf(provider) {
  const data = PROVIDER_DATA[provider.id];
  if (data === void 0) return provider.baseUrl && !provider.baseUrl.includes("{") ? { defaultBaseURL: provider.baseUrl } : {};
  const { env, ...endpoint } = data;
  return { ...endpoint, nativeAuth: { env, oauth: provider.auth.oauth !== void 0 } };
}

// dsh/vendor/dsh-llm-pi-ai/src/index.ts
var name = "llm-pi-ai-carrier-cache";
var NS = "llm-pi-ai";
function registrationFacts(profiles) {
  return [...profiles.entries()].map(([provider, profile2]) => ({
    provider,
    displayName: profile2.displayName,
    retryPolicy: profile2.retryPolicy
  })).sort((left, right) => left.provider.localeCompare(right.provider));
}
function directoryEntries(profiles, settingsNs) {
  const entries = /* @__PURE__ */ new Map();
  const declare = (provider, displayName, error) => {
    const installed = catalogProvider(provider);
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ["providers", provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: installed === void 0,
      ...installed === void 0 ? {} : providerDefaultsOf(installed),
      ...error === void 0 ? {} : { error }
    });
  };
  for (const provider of catalogProviderIds()) declare(provider, provider);
  for (const [provider, profile2] of profiles) declare(provider, profile2.displayName, profile2.catalogError);
  return [...entries.values()];
}
function bootstrap(ctx, config, decorateProfiles) {
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  const settingsNs = ctx.fiber.entry?.options.id ?? NS;
  let lastRaw;
  let memoized;
  const profiles = () => {
    const raw = config.providers.get();
    if (raw === lastRaw && memoized !== void 0) return memoized;
    const next = decorateProfiles(resolveProfiles(structuredClone(raw), "deferred"));
    lastRaw = raw;
    memoized = next;
    return next;
  };
  profiles();
  ctx.on("internal/config", (fiber, next) => {
    const raw = next();
    if (fiber !== ctx.fiber) return raw;
    const candidate = Config(raw);
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) },
      { providers: structuredClone(config.providers.get()) }
    );
    return raw;
  });
  const resolveApiKey = async (provider, profile2) => {
    const ref = profile2.apiKeyEnv;
    if (ref === void 0) return void 0;
    const credentials = ctx.get("credentials");
    const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value : launchEnvironmentOf2(ctx).get(ref)?.value;
    if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, "llm-pi-ai", ref);
    throw new LlmError3(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set \u2014 store ${ref} through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should authenticate from pi-ai's own environment discovery`,
      "MISSING_CREDENTIAL"
    );
  };
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) };
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    prepareHeaders: (request, headers) => ctx.waterfall("llm-pi-ai/request-headers", request, headers, () => headers),
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
      ref
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`
      );
    }
  });
  ctx.inject(["authorization"], (authorized) => {
    registerPiAiFlows(authorized, auth);
  });
  let directory;
  let directoryFacts;
  const ensureDirectory = () => {
    const entries = directoryEntries(profiles(), settingsNs);
    if (deepEqualJson2(entries, directoryFacts)) return;
    if (directory === void 0) {
      directory = ctx.llm.registerConfigurableProviders(entries);
    } else {
      directory.replace(entries);
    }
    directoryFacts = entries;
  };
  ensureDirectory();
  const storedDiscoveryProfile = (provider) => {
    if (provider === void 0) return void 0;
    const profile2 = profiles().get(provider);
    if (profile2 === void 0) return void 0;
    return {
      headers: profile2.headers,
      resolveApiKey: () => resolveApiKey(provider, profile2)
    };
  };
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === void 0 ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider)
  ));
  let registration;
  let registeredFacts;
  let registeredRoutes = [];
  const ensureRegistrationFacts = () => {
    const facts = registrationFacts(profiles());
    if (deepEqualJson2(facts, registeredFacts)) return;
    const routes = [...profiles().keys()];
    if (registration === void 0) {
      if (routes.length === 0) {
        registeredFacts = facts;
        return;
      }
      registration = ctx.llm.registerAdapter(routes, adapter);
    } else {
      registration.replace(routes);
    }
    registeredFacts = facts;
    registeredRoutes = routes;
  };
  ensureRegistrationFacts();
  ctx.on("loader/volatile-update", () => {
    try {
      ensureRegistrationFacts();
      ensureDirectory();
    } catch (error) {
      ctx.logger.error("llm-pi-ai: configuration conflicts with an existing provider route");
      ctx.logger.error(error);
    }
  });
  return { registeredRoutes: () => [...registeredRoutes] };
}

// dsh/src/carrier-cache.js
var MAX_CONTROL_POINTS = 4;
var ADDED = Object.freeze({ result: "added" });
var NATIVE = Object.freeze({ result: "native" });
var skipped = (reason) => Object.freeze({ result: "skipped", reason });
var NO_CARRIER = skipped("no-carrier");
var NO_NATIVE_POINT = skipped("no-native-point");
var POINTS_FULL = skipped("points-full");
var RESPONSES_OFF = skipped("responses-off");
var UNSUPPORTED = skipped("unsupported");
var LONG_RETENTION = "24h";
var LONG_OPTIONS = Object.freeze({ ttl: "30m" });
var textOfBlocks = (blocks) => blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
function createCarrierCache({ carrierPrefix, report, observe = () => {
}, responsesBreakpoint = () => false }) {
  const lastCarrier = (messages, textOf) => messages.findLastIndex((message) => message?.role === "user" && textOf(message).startsWith(carrierPrefix));
  const blocksText = (content) => typeof content === "string" ? content : Array.isArray(content) ? textOfBlocks(content) : "";
  const controlText = (message) => blocksText(message.content);
  const controlled = (parts) => parts.filter((part) => part?.cache_control !== void 0);
  function controlPoint({ message, marked, pick, model }) {
    if (marked.length === 0) return NO_NATIVE_POINT;
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const last = pick(blocks);
    if (last.cache_control !== void 0) return NATIVE;
    if (marked.length >= MAX_CONTROL_POINTS) {
      report(`llm-pi-ai carrier cache: route "${model.provider}/${model.id}" (${model.api}) already sends ${marked.length} cache points, so the last carrier is given none`);
      return POINTS_FULL;
    }
    last.cache_control = { ...marked[0].cache_control };
    if (typeof message.content === "string") message.content = blocks;
    return ADDED;
  }
  const anthropicMarked = (payload) => controlled([
    ...Array.isArray(payload.system) ? payload.system : [],
    ...Array.isArray(payload.tools) ? payload.tools : [],
    ...(Array.isArray(payload.messages) ? payload.messages : []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
  ]);
  function anthropic(payload, model) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(payload.messages, controlText);
    if (at < 0) return NO_CARRIER;
    return controlPoint({ message: payload.messages[at], marked: anthropicMarked(payload), pick: (blocks) => blocks.at(-1), model });
  }
  function completions(payload, model) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(payload.messages, controlText);
    if (at < 0) return NO_CARRIER;
    const marked = controlled([
      ...Array.isArray(payload.tools) ? payload.tools : [],
      ...payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    ]);
    return controlPoint({ message: payload.messages[at], marked, pick: (parts) => parts.findLast((part) => part?.type === "text"), model });
  }
  const bedrockText = (message) => Array.isArray(message.content) ? message.content.filter((block) => typeof block?.text === "string").map((block) => block.text).join("") : "";
  function bedrock(payload) {
    if (!Array.isArray(payload.messages)) return UNSUPPORTED;
    const at = lastCarrier(payload.messages, bedrockText);
    if (at < 0) return NO_CARRIER;
    const blocks = [...Array.isArray(payload.system) ? payload.system : [], ...payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])];
    const point = blocks.find((block) => block?.cachePoint !== void 0);
    if (point === void 0) return NO_NATIVE_POINT;
    const { content } = payload.messages[at];
    if (content.at(-1)?.cachePoint !== void 0) return NATIVE;
    content.push({ cachePoint: { ...point.cachePoint } });
    return ADDED;
  }
  const responsesText = (item) => item?.role === "user" && Array.isArray(item.content) ? item.content.filter((part) => part?.type === "input_text" && typeof part.text === "string").map((part) => part.text).join("") : "";
  const chatGptSignIn = (model, apiKey) => model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && apiKey !== void 0 && !apiKey.startsWith("sk-");
  const switchedOn = () => {
    try {
      return responsesBreakpoint() === true;
    } catch {
      report("llm-pi-ai carrier cache: the Responses breakpoint setting could not be read, so the request is sent without it");
      return false;
    }
  };
  const explicitOptions = (payload) => {
    if (payload.prompt_cache_retention !== LONG_RETENTION) return;
    delete payload.prompt_cache_retention;
    payload.prompt_cache_options = { ...LONG_OPTIONS };
  };
  function responses(payload, model, options) {
    if (!switchedOn()) return RESPONSES_OFF;
    if (!Array.isArray(payload.input) || chatGptSignIn(model, options?.apiKey)) return UNSUPPORTED;
    if (options?.cacheRetention === "none") return NO_NATIVE_POINT;
    const at = lastCarrier(payload.input, responsesText);
    if (at < 0) return NO_CARRIER;
    if (at === payload.input.length - 1) return NATIVE;
    const block = payload.input[at].content.findLast((part) => part?.type === "input_text");
    block.prompt_cache_breakpoint = { mode: "explicit" };
    explicitOptions(payload);
    return ADDED;
  }
  const WRITERS = { "anthropic-messages": anthropic, "bedrock-converse-stream": bedrock, "openai-responses": responses, "openai-completions": completions };
  const observed = (outcome) => {
    try {
      observe(outcome);
    } catch {
      report("llm-pi-ai carrier cache: the cache evidence of a request could not be recorded");
    }
  };
  const hookOf = (earlier, options) => async (payload, model) => {
    const replaced = await earlier?.(payload, model);
    const body = replaced ?? payload;
    const outcome = WRITERS[model.api]?.(body, model, options) ?? UNSUPPORTED;
    observed(outcome);
    return outcome === ADDED ? body : replaced;
  };
  const wrapProvider = (provider) => Object.create(provider, {
    streamSimple: {
      value: (model, context, options) => provider.streamSimple(model, context, { ...options, onPayload: hookOf(options?.onPayload, options) }),
      enumerable: true,
      writable: true,
      configurable: true
    }
  });
  return {
    /** The resolved profiles with each route's pi-ai provider wrapped; a route that resolved none is left as it is. */
    decorateProfiles: (profiles) => new Map([...profiles].map(([route, profile2]) => [
      route,
      profile2.piProvider === void 0 ? profile2 : { ...profile2, piProvider: wrapProvider(profile2.piProvider) }
    ]))
  };
}

// dsh/src/pi-ai-integration.js
var PI_AI_SERVICE = "sessionWatcherPiAi";
var ORIGINAL_ROW = "include:llm-pi-ai";
var CARRIER_EVIDENCE_SERVICE = "sessionWatcherCarrierEvidence";

// dsh/src/pi-ai-index.js
var inject = ["llm", "loader"];
var FAILURE_LOGS = {
  "source-missing": `llm-pi-ai carrier cache: the Loader has no readable row ${ORIGINAL_ROW}, so no route is served`,
  "source-enabled": `llm-pi-ai carrier cache: the row ${ORIGINAL_ROW} is not switched off, so the original adapter serves and this entry serves no route`,
  "source-invalid": `llm-pi-ai carrier cache: the configuration of the row ${ORIGINAL_ROW} is not a usable profile dictionary, so no route is served`
};
function readSource(ctx) {
  let row;
  let disabled;
  try {
    row = ctx.loader.resolve(ORIGINAL_ROW);
    ({ disabled } = row);
  } catch {
    return { cause: "source-missing" };
  }
  if (disabled !== true) return { cause: "source-enabled" };
  try {
    const config = Config(structuredClone(row.options.config ?? {}));
    resolveProfiles(structuredClone(config.providers.get()), "deferred");
    return { config };
  } catch {
    return { cause: "source-invalid" };
  }
}
function apply(ctx) {
  const source = readSource(ctx);
  if (source.cause !== void 0) {
    ctx.logger.error(FAILURE_LOGS[source.cause]);
    ctx.provide(PI_AI_SERVICE, { failure: { cause: source.cause } });
    return;
  }
  const cache = createCarrierCache({
    carrierPrefix: CARRIER_WORDING.addresses,
    report: (message) => ctx.logger.warn(message),
    observe: (result) => ctx.get(CARRIER_EVIDENCE_SERVICE)?.record(result),
    responsesBreakpoint: () => ctx.get(CARRIER_EVIDENCE_SERVICE)?.responsesBreakpoint?.()
  });
  const registration = bootstrap(ctx, source.config, cache.decorateProfiles);
  ctx.provide(PI_AI_SERVICE, {
    failure: null,
    cacheRetention: (route) => source.config.providers.get()[route]?.cacheRetention ?? null,
    routes: () => registration.registeredRoutes()
  });
}
export {
  apply,
  inject,
  name
};
