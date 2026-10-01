# Leeheisen Plan — 吸收 xman88 UnityMCP 1.2.8 的提示工程质量

分支：`leeheisen`
来源：`my-mcp/unity-mcp-v1.2.8-all`（`com.unitymcp.server` 1.2.8，加密 DLL）反编译并去混淆后的源码
目标工程：AnkleBreaker Unity MCP Server

---

## 1. 背景

AnkleBreaker 的覆盖面（347 工具 / 40+ 分类）远大于 xman88 的 20 工具 / 85 动作，但后者的
**提示工程质量**明显更高：每个动作都带 FullDescription、参数说明、取值示例、工作流、常见错误，
另有一个随包内置的 Unity 知识库（组件属性表、UI 设计规则、Anchor 预设、布局范式）。

本计划的全部内容是“把后者的**数据与提示工程结构**搬到前者”，不引入 xman88 的服务端实现、
许可校验、混淆或桥接协议。

## 2. 可复用资产清单（已提取验证）

| 资产 | 规模 | 提取来源 |
| --- | --- | --- |
| 工具指南 `tool-guides.json` | 55 条 guide / 104 个参数说明 / 10 个分类，139.6 KB | 10 个 `*Tools.cs` 的 `GetToolGuides()` |
| Unity 知识库 `unity-knowledge.json` | 76 个组件、474 条属性说明、15 个布局范式、16 个 Anchor 预设、4.5 KB UI 设计规则，92.7 KB | `KnowledgeData.cs` |
| 本地化字符串 | 20 种语言 × 390 键 | `Editor/Localization/*.json` |

数据提取由 `tools/extract-xman88-knowledge.py`（本仓库 `tools/` 下）完成，脚本可重复运行。

## 3. 设计

### 3.1 数据层（`src/data/xman88/`）

```
src/data/xman88/
  tool-guides.json      # { "<Category>": { "<action>": { fullDescription, parameters[], examples[], workflows[], unityVersionNotes, commonErrors[] } } }
  unity-knowledge.json  # { components, layoutPatterns, anchorPresets, uiDesignRules }
  tool-map.json         # "<Category>.<action>" → [ "<anklebreaker tool name>", ... ]
  i18n/<locale>.json    # 20 语言的 UI 文案（原样保留）
  PROVENANCE.md         # 数据来源与再生成方式
```

**关键约束：这份数据不进 `tools/list` 的 schema description。**
AnkleBreaker 已经踩过一次坑（268 工具 / 125 KB 的 tools/list 让 Claude Cowork 静默注册失败，
见 `src/tool-tiers.js` 顶部注释）。指南文本必须按需检索，绝不塞进每个工具的 description。

### 3.2 检索层（`src/knowledge.js`）

纯函数模块，无网络、无 IO 之外的副作用：

* `getGuideForTool(toolName)` → 合并该工具映射到的所有 guide（去重）
* `getCommonErrors(toolName)` → 仅取 `commonErrors[]`，供错误增强使用
* `searchKnowledge({ topic, query, limit })` → 跨 tool-guides / components / layoutPatterns /
  anchorPresets / uiDesignRules / i18n 的统一检索（大小写不敏感，子串匹配 + 简单打分）
* `listTopics()` → 返回可用 topic 列表与条目数（供 agent 自举）

topic 取值（对齐 xman88 的 `KnowledgeTools`）：
`tool_guide`、`component_properties`、`layout_patterns`、`anchor_presets`、`ui_design_rules`、`i18n`。
保留 xman88 的别名表（`ui`→`ui_design_rules`、`anchors`→`anchor_presets`）。

### 3.3 工具层

新增 1 个 MCP 工具 `unity_knowledge`，放在 **meta 层**（与 `unity_advanced_tool` 同级），
不占核心工具的信任额度：

```
unity_knowledge(topic?, query?, tool?, limit?)
  topic   : tool_guide | component_properties | layout_patterns | anchor_presets | ui_design_rules | i18n
  query   : 关键词（组件名 / 属性名 / 动作名 / 文案 key）
  tool    : 直接按 AnkleBreaker 工具名取指南，等价于 topic=tool_guide + 精确匹配
  limit   : 默认 5，最大 20，防止把知识库整段倒进上下文
```

输出同时附一行 “how to narrow further” 的提示，避免 agent 一次拉太多。

### 3.4 错误增强（`src/index.js`）

在 `CallToolRequestSchema` 的返回路径上（现有 `isErrorText(result)` 判定处）增加：

1. 失败时按工具名取 `commonErrors[]`，最多附 3 条，前缀 `💡 常见原因:`；
2. 附一行 `Get full usage: unity_knowledge(tool:"<当前工具名>")`；
3. 命中“未知路由”时保留原有的 did-you-mean 行为，两者叠加不冲突；
4. 通过环境变量 `UNITY_MCP_NO_ERROR_HINTS=1` 可关闭（默认开启）。

### 3.5 分类裁剪（`src/tool-tiers.js`）

新增 `UNITY_MCP_DISABLED_CATEGORIES=terrain,amplify,uma,...`：命中分类的工具在暴露前被过滤
（`core` 与 `advanced` 都过滤，`unity_advanced_tool` 的目录同步缩小）。用于在超大工程或
schema 敏感客户端上换取注册成功率。

### 3.6 本地化

`i18n/<locale>.json` 原样保留，通过 `unity_knowledge(topic:"i18n", query:"<key>")` 可查。
本轮不改动 `tools/list` 的描述语言（MCP 描述由模型消费，默认英文），仅把数据备好。

## 4. 覆盖映射

`tool-map.json` 把 xman88 的 55 个动作 key 映射到 AnkleBreaker 的实际工具名，例如：

| xman88 key | AnkleBreaker 工具 |
| --- | --- |
| `ComponentTools.addComponent` | `unity_component_add` |
| `GameObjectTools.createGameObject` | `unity_gameobject_create` |
| `SceneTools.getSceneHierarchy` | `unity_scene_hierarchy` |
| `PrefabTools.applyPrefabChanges` | `unity_prefab_apply_overrides` |
| `AssetTools.createAsset` | `unity_asset_import` |
| `EditorTools.executeMenuItem` | `unity_execute_menu_item` |
| `ShaderTools.createMaterial` | `unity_material_create` |
| `ValidationTools.findMissingScripts` | `unity_search_missing_references` |

映射不到现有工具的原版动作（`ProjectTools.createFolder`、`DebugTools.pauseEditor`、
`ValidationTools.optimizeTextures` 等）保留 `[]`，仍可通过 `unity_knowledge(topic:"tool_guide", query:...)`
检索到 —— 这些条目同时也是一份“AnkleBreaker 可以做但尚未提供对应工具”的候选清单。

## 5. 测试计划

**单元（新增 `tests/unit/knowledge.test.mjs`）**

1. `tool-guides.json` 可解析，55 条 guide 全部有 `fullDescription`；
2. `tool-map.json` 引用的每个 AnkleBreaker 工具名都真实存在于工具表（防止改名后静默失效）；
3. `getGuideForTool("unity_component_add")` 返回 `addComponent` 的指南；
4. `searchKnowledge` 对 `anchorMin`、`health_bar`、`ScrollRect` 等关键词命中预期 topic；
5. 未映射工具返回空数组而不是抛错。

**协议（扩展 `tests/protocol.test.mjs`）**

6. `tools/list` 体积回归：新增工具后仍低于既有阈值（脚本内打印实际 KB）；
7. `unity_knowledge` 的 6 个 topic 各调用一次，验证返回结构；
8. 错误增强：mock bridge 返回失败时，响应里出现 `💡 常见原因` 与 `unity_knowledge` 提示；
9. `UNITY_MCP_NO_ERROR_HINTS=1` 时不再注入；
10. `UNITY_MCP_DISABLED_CATEGORIES=terrain` 时 `unity_terrain_*` 不出现在 `tools/list`。

**活体（本地 Unity 工程）**

11. 在本地 Unity 工程接入 AnkleBreaker 插件，确认 bridge 可用（`unity_editor_ping`）；
12. 场景/GameObject/组件 三个核心动作的真实调用；
13. 故意触发一次失败（例如对不存在的 GameObject 调用 `unity_component_add`），确认错误提示被附上；
14. `unity_knowledge(tool:"unity_component_add")` 在真实会话中返回指南。

## 6. 验收标准

* `npm test` 全绿，新增用例覆盖第 5 节 1–10；
* `tools/list` 暴露的工具数从 78 → 79，payload 增幅 < 2 KB；
* 任意一个失败的工具调用，其响应中包含至少 1 条来自知识库的提示；
* 数据全部来自本仓库内文件，运行时零网络请求；
* `PROVENANCE.md` 说明数据来源与再生成方式。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 指南数据撑大 tools/list | 指南不进 description，只走 `unity_knowledge`；协议测试加体积断言 |
| 映射表随工具改名失效 | 单元测试 2 断言映射目标必须存在于工具表 |
| 错误提示干扰正常返回 | 只在 `isErrorText` 为真时注入，且可通过环境变量关闭 |
| 知识内容与当前 Unity 版本不符 | guide 保留 `unityVersionNotes` 字段；`unity_knowledge` 输出里带上该字段 |
| 数据来源合规 | 用户已确认这些为通用 Unity 知识；`PROVENANCE.md` 记录来源与再生成脚本 |

## 8. 任务拆分

| # | 任务 | 产物 |
| --- | --- | --- |
| T1 | 数据提取脚本 | `tools/extract-xman88-knowledge.py` |
| T2 | 数据落库 | `src/data/xman88/{tool-guides,unity-knowledge,tool-map}.json` + `i18n/` + `PROVENANCE.md` |
| T3 | 检索层 | `src/knowledge.js` |
| T4 | `unity_knowledge` 工具接入 meta 层 | `src/tool-tiers.js` / `src/index.js` |
| T5 | 错误增强 | `src/index.js` |
| T6 | 分类裁剪 | `src/tool-tiers.js` |
| T7 | 单元 + 协议测试 | `tests/unit/knowledge.test.mjs`、`tests/protocol.test.mjs` |
| T8 | 本地 Unity 活体验证 | 测试记录追加到本文件 |

## 9. 活体验证记录

验证环境：Unity **6000.3.13f1**（本机 Hub 安装），工程 `tmp/ab-unity6`，
插件 `com.anklebreaker.unity-mcp 2.40.1`（GitHub `unity-mcp-plugin` 主干），
bridge 监听 `127.0.0.1:7890`，`/api/ping` 返回 `protocolVersion=1`。

> 注意：本机 2021.3.45f2 无法编译该插件（`EditorApplication.focusChanged`、
> `IntegerField` 在 2021.3 不存在），且裸工程需要显式添加 `com.unity.ugui`
> 与 `com.unity.test-framework`，否则 `MCPUICommands.cs` / `MCPTestRunnerCommands.cs` 编译失败。

### 自动化结果

| 用例 | 结果 |
| --- | --- |
| `npm test`（单元 + 协议，mock bridge） | **73/73 通过**；tools/list 47.6 KB / 81 工具，compact 23.3 KB |
| `UNITY_MCP_LIVE=1 node --test tests/live-knowledge.test.mjs` | **5/5 通过** |
| `UNITY_MCP_LIVE=1 node --test tests/live-smoke.test.mjs`（原有基线） | **5/5 通过** |

### 真实编辑器上的观察

1. `unity_list_instances` 发现 `ab-unity6@7890`；`unity_editor_ping`、`unity_scene_info`
   往返正常（`unityVersion=6000.3.13f1`）。
2. **按指南驱动的调用序列真的改动了场景**：`unity_gameobject_create(LeeheisenProbe)`
   → `unity_component_add(componentType="Rigidbody")` → `unity_component_get_properties`
   回读得到 `m_Mass=1`（指南里 “addComponent 'Rigidbody'” 的示例照抄可用）。
3. **失败注入有效**：对不存在的 GameObject 调用 `unity_component_add` 返回 `isError=true`，
   响应里同时出现 `💡 Common causes` 与 `unity_knowledge(tool:"unity_component_add")`；
   顺着该指针查询，返回的指南里确实含 `ERROR: 'GameObject not found'` 条目。
4. `unity_knowledge(topic:"component_properties", query:"Rigidbody mass")` 命中 `mass` 属性说明。
5. 探针对象在 `after()` 中删除，工程保持干净。

### 实测新增工具的体积

`unity_knowledge` 的 schema 为 775 字节（描述两行、属性各一行），是本能力的下限；
55 条指南、76 个组件、15 个布局范式、16 个锚点预设、20 语言文案全部留在
`src/data/xman88/`，只在调用时读取，从不进入 `tools/list`。
