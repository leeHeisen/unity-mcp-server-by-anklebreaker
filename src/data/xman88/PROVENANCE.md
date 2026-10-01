# Provenance — `src/data/xman88/`

These files carry the prompt-engineering payload of the xman88 *Unity MCP Server*
(`com.unitymcp.server` 1.2.8) into this server. They contain **data only** — no code,
no licensing logic, no transport or bridge implementation from that package.

| File | Origin |
| --- | --- |
| `tool-guides.json` | `GetToolGuides()` dictionaries in the package's `*Tools.cs` editor classes |
| `unity-knowledge.json` | `ToolsV2/KnowledgeData.cs` (`Components`, `LayoutPatterns`, `AnchorPresets`, `GetUIDesignRules()`) |
| `i18n/*.json` | `Editor/Localization/*.json` (20 locales, verbatim) |
| `tool-map.json` | Authored here — maps each guide key to the AnkleBreaker tool that implements the same operation |

## Regenerating

The first three entries are produced from a decompiled copy of the package:

```bash
python tools/extract-xman88-knowledge.py --source <decompiled>/UnityMCP/UnityMCP/Editor
```

`tool-map.json` is maintained by hand. `tests/unit/knowledge.test.mjs` fails if it ever
references a tool name that no longer exists, so a rename in `src/tools/*.js` cannot
silently orphan the guides.

## Runtime behaviour

The server reads these JSON files with `fs.readFileSync` at startup. There is no network
access, no telemetry and no dependency on the original product. Anything the guides
describe is applied by this server's own tools; where no equivalent tool exists the
guide stays searchable through `unity_knowledge(topic:"tool_guide", …)` and is listed as
an unmapped entry in `tool-map.json`.

## Scope note

The content is ordinary Unity API/editor knowledge (component properties, UI anchoring,
layout patterns, tool usage guidance). It is kept as data so it can be reviewed, diffed
and regenerated — not copied into code paths.
