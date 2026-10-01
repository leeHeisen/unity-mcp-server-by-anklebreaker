// AnkleBreaker Unity MCP — knowledge retrieval
//
// Serves the per-tool usage guides and the Unity knowledge base on demand, so that
// neither has to sit inside the tools/list payload. Adapted from the prompt-engineering
// payload of the xman88 Unity MCP 1.2.8 package (see src/data/xman88/PROVENANCE.md).
//
// Design rules:
//   1. Nothing here is ever injected into a tool's JSON schema — the model asks for it.
//   2. Every lookup is bounded: a hard character cap plus a per-call result limit.
//   3. Pure data + pure functions: no network, no Unity round-trip.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data", "xman88");

const MAX_OUTPUT_CHARS = 7000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function loadJson(file) {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[MCP] knowledge: failed to parse ${file}: ${err.message}`);
    return null;
  }
}

const TOOL_GUIDES = loadJson("tool-guides.json") || {};
const KNOWLEDGE = loadJson("unity-knowledge.json") || {};
const TOOL_MAP = loadJson("tool-map.json") || {};

const TOPIC_ALIASES = {
  tool_guide: "tool_guide",
  tool_guides: "tool_guide",
  guide: "tool_guide",
  guides: "tool_guide",
  usage: "tool_guide",
  component_properties: "component_properties",
  component: "component_properties",
  components: "component_properties",
  properties: "component_properties",
  layout_patterns: "layout_patterns",
  layout: "layout_patterns",
  layouts: "layout_patterns",
  patterns: "layout_patterns",
  anchor_presets: "anchor_presets",
  anchor: "anchor_presets",
  anchors: "anchor_presets",
  ui_design_rules: "ui_design_rules",
  ui_rules: "ui_design_rules",
  ui: "ui_design_rules",
  design_rules: "ui_design_rules",
  rules: "ui_design_rules",
  i18n: "i18n",
  locale: "i18n",
  locales: "i18n",
};

const TOPIC_DESCRIPTIONS = {
  tool_guide: "Per-tool usage guide: what it does, parameters, examples, workflows, common errors.",
  component_properties: "Unity component reference: serialized properties, types, defaults.",
  layout_patterns: "Reusable UI layout structures (HUD, inventory grid, settings form, …).",
  anchor_presets: "RectTransform anchor/pivot presets with explanations.",
  ui_design_rules: "Unity UI design rules: coordinates, sizing, spacing, performance, accessibility.",
  i18n: "Editor UI strings in 20 locales (query = message key, or 'zh:bridge.title').",
};

/** Every guide key ("<Category>.<action>") in the payload. */
function allGuideKeys() {
  const keys = [];
  for (const [category, entries] of Object.entries(TOOL_GUIDES)) {
    for (const action of Object.keys(entries || {})) keys.push(`${category}.${action}`);
  }
  return keys;
}

/** Guides whose xman88 action is implemented by the given AnkleBreaker tool. */
export function getGuidesForTool(toolName) {
  if (!toolName) return [];
  const wanted = String(toolName).trim();
  const out = [];
  for (const [key, targets] of Object.entries(TOOL_MAP)) {
    if (key.startsWith("_") || !Array.isArray(targets)) continue;
    if (!targets.includes(wanted)) continue;
    const [category, action] = key.split(".");
    const guide = TOOL_GUIDES[category]?.[action];
    if (guide) out.push({ key, category, action, guide });
  }
  return out;
}

/** Back-compat: the first guide mapped to a tool, or null. */
export function getGuideForTool(toolName) {
  return getGuidesForTool(toolName)[0] || null;
}

/**
 * Common-error strings for a tool, for the failure path in index.js.
 * Returns [] when the tool has no mapped guide.
 */
export function getCommonErrors(toolName, max = 3) {
  const errors = [];
  for (const entry of getGuidesForTool(toolName)) {
    for (const line of entry.guide.commonErrors || []) {
      if (line && !errors.includes(line)) errors.push(line);
      if (errors.length >= max) return errors;
    }
  }
  return errors;
}

function normalize(value) {
  return String(value == null ? "" : value).toLowerCase();
}

function matchesAll(haystack, words) {
  const text = normalize(haystack);
  return words.every((w) => text.includes(w));
}

function truncate(text, max = 600) {
  const value = String(text == null ? "" : text);
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function formatParameter(param) {
  const bits = [];
  bits.push(`  - ${param.name} (${param.type}${param.required ? ", required" : ""})`);
  if (param.description) bits.push(`: ${truncate(param.description, 400)}`);
  const lines = [bits.join("")];
  if (param.constraints) lines.push(`      constraints: ${truncate(param.constraints, 200)}`);
  if (Array.isArray(param.valueExamples) && param.valueExamples.length) {
    lines.push(`      examples: ${param.valueExamples.slice(0, 8).join(" | ")}`);
  }
  if (param.defaultValue !== null && param.defaultValue !== undefined) {
    lines.push(`      default: ${truncate(param.defaultValue, 80)}`);
  }
  return lines.join("\n");
}

function formatGuide(entry, toolName) {
  const g = entry.guide;
  const title = toolName ? `${toolName} → ${entry.key}` : entry.key;
  const out = [`### ${title}`];
  if (g.fullDescription) out.push(truncate(g.fullDescription, 1200));
  const params = g.parameters || [];
  if (params.length) {
    out.push("Parameters:");
    out.push(params.map(formatParameter).join("\n"));
  }
  const list = (label, values, max) => {
    if (Array.isArray(values) && values.length) {
      out.push(`${label}:`);
      for (const v of values.slice(0, max)) out.push(`  - ${truncate(v, 400)}`);
    }
  };
  list("Examples", g.examples, 4);
  list("Workflows", g.workflows, 4);
  list("Common errors", g.commonErrors, 6);
  if (g.unityVersionNotes) out.push(`Unity version notes: ${truncate(g.unityVersionNotes, 300)}`);
  return out.join("\n");
}

function searchToolGuides(query, toolName, limit) {
  if (toolName) {
    const hits = getGuidesForTool(toolName);
    if (hits.length) return hits.slice(0, limit).map((h) => formatGuide(h, toolName));
  }
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const [category, entries] of Object.entries(TOOL_GUIDES)) {
    for (const [action, guide] of Object.entries(entries || {})) {
      const haystack = [
        category,
        action,
        guide.fullDescription,
        (guide.parameters || []).map((p) => `${p.Name} ${p.Description}`).join(" "),
        (guide.examples || []).join(" "),
        (guide.workflows || []).join(" "),
        (guide.commonErrors || []).join(" "),
      ].join(" ");
      if (!matchesAll(haystack, words)) continue;
      // Prefer matches on the action name, then on the description.
      let score = 0;
      if (words.every((w) => normalize(action).includes(w))) score += 10;
      if (words.every((w) => normalize(category).includes(w))) score += 3;
      scored.push({ score, key: `${category}.${action}`, category, action, guide });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((entry) => formatGuide(entry, null));
}

function searchComponents(query, limit) {
  const components = KNOWLEDGE.components || {};
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const out = [];
  for (const [name, info] of Object.entries(components)) {
    const props = info.properties || {};
    const propNames = Object.keys(props);
    const haystack = [name, info.fullType, info.category, info.description, propNames.join(" ")].join(" ");
    if (words.length && !matchesAll(haystack, words)) continue;
    const lines = [`### ${name}${info.fullType ? ` (${info.fullType})` : ""}${info.category ? ` — ${info.category}` : ""}`];
    if (info.description) lines.push(truncate(info.description, 400));
    const shown = propNames.filter((p) => !words.length || words.some((w) => normalize(p).includes(w)));
    const list = (shown.length ? shown : propNames).slice(0, words.length ? 12 : 24);
    if (list.length) {
      lines.push("Properties:");
      for (const p of list) {
        const pi = props[p] || {};
        lines.push(
          `  - ${p} (${pi.type || "?"}${pi.default ? `, default ${pi.default}` : ""}): ${truncate(pi.description, 200)}`
        );
      }
      if (propNames.length > list.length) lines.push(`  … ${propNames.length - list.length} more properties`);
    }
    out.push(lines.join("\n"));
    if (out.length >= limit) break;
  }
  return out;
}

function searchDictionary(dict, query, limit, formatter) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const out = [];
  for (const [name, value] of Object.entries(dict || {})) {
    if (words.length) {
      const haystack = [name, ...Object.values(value || {})].join(" ");
      if (!matchesAll(haystack, words)) continue;
    }
    out.push(formatter(name, value));
    if (out.length >= limit) break;
  }
  return out;
}

function searchUiDesignRules(query) {
  const rules = KNOWLEDGE.uiDesignRules || "";
  if (!rules) return [];
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [rules];
  const sections = rules.split(/\n(?=## )/);
  const hits = sections.filter((section) => matchesAll(section, words));
  return hits.length ? [hits.join("\n")] : [];
}

function searchI18n(query, limit) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  const [maybeLocale, ...rest] = raw.split(":");
  const locale = rest.length ? maybeLocale.toLowerCase() : "en";
  const key = rest.length ? rest.join(":").trim() : raw;
  const dict = loadJson(join("i18n", `${locale}.json`));
  if (!dict) return [`Unknown locale "${locale}". Try one of: ` + listLocales().join(", ")];
  const exact = dict[key];
  if (exact) return [`${locale}:${key} = ${exact}`];
  const words = normalize(key).split(/\s+/).filter(Boolean);
  const hits = Object.entries(dict)
    .filter(([k]) => matchesAll(k, words))
    .slice(0, limit)
    .map(([k, v]) => `${locale}:${k} = ${v}`);
  return hits;
}

export function listLocales() {
  return ["ar", "de", "en", "es", "fil", "fr", "hi", "id", "it", "jp", "ko", "ms", "pl", "pt", "ru", "th", "tr", "vi", "zh", "zh-TW"];
}

export function listTopics() {
  const guideCount = allGuideKeys().length;
  const topics = [
    ["tool_guide", guideCount],
    ["component_properties", Object.keys(KNOWLEDGE.components || {}).length],
    ["layout_patterns", Object.keys(KNOWLEDGE.layoutPatterns || {}).length],
    ["anchor_presets", Object.keys(KNOWLEDGE.anchorPresets || {}).length],
    ["ui_design_rules", KNOWLEDGE.uiDesignRules ? 1 : 0],
    ["i18n", listLocales().length],
  ];
  return topics.map(([topic, count]) => ({ topic, count, description: TOPIC_DESCRIPTIONS[topic] }));
}

/**
 * Single entry point behind the unity_knowledge tool.
 * Always returns a string — never throws.
 */
export function searchKnowledge({ topic, query, tool, limit } = {}) {
  let cap = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  cap = Math.max(1, Math.min(MAX_LIMIT, cap));
  const resolved = TOPIC_ALIASES[normalize(topic)] || (tool ? "tool_guide" : null);

  let blocks = [];
  if (!resolved) {
    blocks = [
      "Available topics:",
      ...listTopics().map((t) => `  - ${t.topic} (${t.count}): ${t.description}`),
      'Example: unity_knowledge(topic:"tool_guide", query:"add component")',
    ].join("\n");
    return compose(blocks);
  }

  switch (resolved) {
    case "tool_guide":
      blocks = searchToolGuides(query, tool, cap);
      break;
    case "component_properties":
      blocks = searchComponents(query, cap);
      break;
    case "layout_patterns":
      blocks = searchDictionary(KNOWLEDGE.layoutPatterns, query, cap, (name, v) =>
        [
          `### ${v.name || name} (${name})`,
          v.description,
          v.structure ? `Structure:\n${v.structure}` : null,
          v.notes ? `Notes: ${v.notes}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
      break;
    case "anchor_presets":
      blocks = searchDictionary(KNOWLEDGE.anchorPresets, query, cap, (name, v) =>
        `  - ${name}: min=${v.anchorMin} max=${v.anchorMax} pivot=${v.pivot} — ${v.desc}`
      );
      break;
    case "ui_design_rules":
      blocks = searchUiDesignRules(query);
      break;
    case "i18n":
      blocks = searchI18n(query, cap);
      break;
    default:
      blocks = [];
  }

  if (!blocks.length) {
    return compose(
      `No ${resolved} entry matched ${query || tool ? `"${query || tool}"` : "(empty query)"}.\n` +
        `Topics available: ${listTopics()
          .map((t) => t.topic)
          .join(", ")}. Call unity_knowledge with no arguments for the full topic list.`
    );
  }

  const header = tool ? `Knowledge for ${tool}:` : `Knowledge (${resolved}):`;
  const footer =
    blocks.length >= cap
      ? `\n\n(Showing ${blocks.length} result(s). Narrow with a more specific query, or raise limit up to ${MAX_LIMIT}.)`
      : "";
  return compose([header, blocks.join("\n\n")].join("\n") + footer);
}

function compose(text) {
  const value = String(text);
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return value.slice(0, MAX_OUTPUT_CHARS) + "\n…(truncated — narrow the query for more detail)";
}

/**
 * Build the hint appended to a failing tool call. Returns "" when the tool has no guide.
 */
export function buildErrorHint(toolName) {
  const errors = getCommonErrors(toolName, 3);
  if (!errors.length) return "";
  const lines = ["💡 Common causes:"];
  for (const err of errors) lines.push(`  - ${truncate(err, 300)}`);
  lines.push(`Full guide: unity_knowledge(tool:"${toolName}")`);
  return lines.join("\n");
}

export function createKnowledgeTool() {
  return {
    name: "unity_knowledge",
    description:
      "Unity knowledge on demand: per-tool usage guides (parameters, examples, workflows, common " +
      "errors), component/property reference, UI layout patterns, anchor presets, UI design rules, " +
      '20-locale editor strings. No args → topics; tool="unity_<tool>" → that tool\'s guide.',
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "tool_guide | component_properties | layout_patterns | anchor_presets | ui_design_rules | i18n",
        },
        query: {
          type: "string",
          description: 'Keywords, e.g. "anchorMin", "health bar".',
        },
        tool: {
          type: "string",
          description: 'Exact tool name, e.g. "unity_component_add". Implies topic=tool_guide.',
        },
        limit: {
          type: "number",
          description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
    },
    handler: async (params) => searchKnowledge(params || {}),
  };
}

export const _internals = { DATA_DIR, MAX_OUTPUT_CHARS, DEFAULT_LIMIT, MAX_LIMIT };
