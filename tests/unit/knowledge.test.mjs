// Unit tests for the knowledge layer (src/knowledge.js).
//
// The xman88 payload is data, so these tests are mostly about *wiring*: the JSON must
// parse, the tool map must not drift away from the real tool surface, and a lookup must
// never throw — an agent calling unity_knowledge with junk should get a usable answer,
// not a stack trace.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  getGuideForTool,
  getGuidesForTool,
  getCommonErrors,
  searchKnowledge,
  listTopics,
  listLocales,
  buildErrorHint,
  _internals,
} from "../../src/knowledge.js";
import { editorTools } from "../../src/tools/editor-tools.js";
import { umaTools } from "../../src/tools/uma-tools.js";
import { probuilderTools } from "../../src/tools/probuilder-tools.js";
import { hubTools } from "../../src/tools/hub-tools.js";
import { instanceTools } from "../../src/tools/instance-tools.js";
import { contextTools } from "../../src/tools/context-tools.js";

const DATA = _internals.DATA_DIR;
const read = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

const TOOL_GUIDES = read("tool-guides.json");
const KNOWLEDGE = read("unity-knowledge.json");
const TOOL_MAP = read("tool-map.json");

const ALL_TOOL_NAMES = new Set(
  [...editorTools, ...umaTools, ...probuilderTools, ...hubTools, ...instanceTools, ...contextTools].map((t) => t.name)
);

describe("knowledge payload", () => {
  test("tool guides parse and every guide carries a description", () => {
    const categories = Object.keys(TOOL_GUIDES);
    assert.ok(categories.length >= 10, `expected >=10 categories, got ${categories.length}`);

    let count = 0;
    for (const [category, entries] of Object.entries(TOOL_GUIDES)) {
      for (const [action, guide] of Object.entries(entries)) {
        count += 1;
        assert.ok(guide.fullDescription, `${category}.${action} is missing fullDescription`);
        assert.ok(Array.isArray(guide.parameters), `${category}.${action} parameters must be a list`);
        for (const param of guide.parameters) {
          assert.equal(typeof param.name, "string", `${category}.${action} parameter without a name`);
        }
      }
    }
    assert.equal(count, 55, "guide count is pinned — update deliberately when re-extracting");
  });

  test("every tool-map target exists in the real tool surface", () => {
    const dangling = [];
    for (const [key, targets] of Object.entries(TOOL_MAP)) {
      if (key.startsWith("_")) continue;
      assert.ok(Array.isArray(targets), `${key} must map to an array`);
      for (const target of targets) {
        if (!ALL_TOOL_NAMES.has(target)) dangling.push(`${key} → ${target}`);
      }
    }
    assert.deepEqual(dangling, [], "tool-map references tools that no longer exist");
  });

  test("every tool-map key resolves to a real guide", () => {
    const missing = [];
    for (const key of Object.keys(TOOL_MAP)) {
      if (key.startsWith("_")) continue;
      const [category, action] = key.split(".");
      if (!TOOL_GUIDES[category]?.[action]) missing.push(key);
    }
    assert.deepEqual(missing, []);
  });

  test("knowledge base carries the expected reference data", () => {
    assert.ok(Object.keys(KNOWLEDGE.components).length >= 70);
    assert.ok(Object.keys(KNOWLEDGE.layoutPatterns).length >= 10);
    assert.ok(Object.keys(KNOWLEDGE.anchorPresets).length >= 10);
    assert.ok(KNOWLEDGE.uiDesignRules.length > 1000);
    // Property entries must be shaped {type, description, default}
    const rect = KNOWLEDGE.components.RectTransform;
    assert.equal(rect.fullType, "UnityEngine.RectTransform");
    assert.equal(typeof rect.properties.anchorMin.type, "string");
    assert.equal(typeof rect.properties.anchorMin.description, "string");
  });

  test("i18n locales are present", () => {
    assert.equal(listLocales().length, 20);
    const en = JSON.parse(readFileSync(join(DATA, "i18n", "en.json"), "utf8"));
    assert.ok(Object.keys(en).length > 300);
  });
});

describe("knowledge lookups", () => {
  test("guide lookup by tool name", () => {
    const guide = getGuideForTool("unity_component_add");
    assert.ok(guide, "unity_component_add must have a guide");
    assert.equal(guide.key, "ComponentTools.addComponent");
    assert.ok(guide.guide.parameters.some((p) => p.name === "componentType"));
  });

  test("a tool without any guide returns empty, not undefined", () => {
    assert.deepEqual(getGuidesForTool("unity_terrain_raise_lower"), []);
    assert.equal(getGuideForTool("unity_definitely_not_a_tool"), null);
    assert.deepEqual(getCommonErrors("unity_definitely_not_a_tool"), []);
  });

  test("common errors are available for the failure hint", () => {
    const errors = getCommonErrors("unity_component_add", 3);
    assert.ok(errors.length > 0);
    assert.ok(errors.length <= 3);
    const hint = buildErrorHint("unity_component_add");
    assert.match(hint, /Common causes/);
    assert.match(hint, /unity_knowledge\(tool:"unity_component_add"\)/);
    assert.equal(buildErrorHint("unity_terrain_raise_lower"), "");
  });

  test("searchKnowledge answers every topic", () => {
    const cases = [
      ["tool_guide", "add component"],
      ["component_properties", "anchorMin"],
      ["layout_patterns", "health bar"],
      ["anchor_presets", "stretch"],
      ["ui_design_rules", "safearea"],
      ["i18n", "zh:bridge.title"],
    ];
    for (const [topic, query] of cases) {
      const out = searchKnowledge({ topic, query, limit: 2 });
      assert.equal(typeof out, "string", `${topic} must return a string`);
      assert.ok(out.length > 0, `${topic}/${query} returned nothing`);
      assert.doesNotMatch(out, /undefined \(/, `${topic}/${query} leaked an undefined field`);
    }
  });

  test("aliases resolve to canonical topics", () => {
    assert.match(searchKnowledge({ topic: "ui", query: "safearea" }), /Multi-Resolution|SafeArea|Canvas/);
    assert.match(searchKnowledge({ topic: "anchors", query: "stretch" }), /stretch_full/);
  });

  test("no arguments lists topics with counts", () => {
    const out = searchKnowledge({});
    for (const { topic, count } of listTopics()) {
      assert.match(out, new RegExp(`${topic} \\(${count}\\)`));
    }
  });

  test("unknown topic and empty results stay usable", () => {
    assert.match(searchKnowledge({ topic: "nonsense" }), /Available topics/);
    assert.match(searchKnowledge({ topic: "component_properties", query: "zzz_no_such_component" }), /No component_properties entry matched/);
  });

  test("output is bounded regardless of limit", () => {
    const out = searchKnowledge({ topic: "ui_design_rules" });
    assert.ok(out.length <= _internals.MAX_OUTPUT_CHARS + 100, "output must respect the character cap");
    const bounded = searchKnowledge({ topic: "component_properties", limit: 999 });
    assert.ok(bounded.length <= _internals.MAX_OUTPUT_CHARS + 100);
  });

  test("limit default and ceiling are enforced", () => {
    assert.equal(_internals.DEFAULT_LIMIT, 5);
    assert.equal(_internals.MAX_LIMIT, 20);
  });
});
