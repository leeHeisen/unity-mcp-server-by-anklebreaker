// Live test — the knowledge layer against a REAL Unity Editor bridge.
//
// Gated: only runs with UNITY_MCP_LIVE=1 and an open Unity Editor carrying the
// AnkleBreaker plugin (`Window → AB Unity MCP`). It is the functional check for
// docs/leeheisen-plan.md §5.11–14: a guide-driven tool call, a real failure, and the
// hint that failure produces.
//
//   UNITY_MCP_LIVE=1 node --test tests/live-knowledge.test.mjs
//
// The GameObject it creates is deleted in `after()`, so a throwaway project stays clean.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { McpTestClient } from "./helpers/mcp-client.mjs";

const LIVE = process.env.UNITY_MCP_LIVE === "1";
const PROBE_NAME = "LeeheisenProbe";

describe("live knowledge layer", { skip: !LIVE && "set UNITY_MCP_LIVE=1 with a running Unity editor" }, () => {
  /** @type {McpTestClient} */ let client;
  let port = null;

  before(async () => {
    client = new McpTestClient({ env: {}, timeoutMs: 60_000 }).start();
    await client.initialize();
    const { payload } = await client.callTool("unity_list_instances");
    port = payload.instances?.[0]?.port ?? null;
    assert.ok(port, "a live Unity instance with the MCP plugin must be discoverable");
    console.error(`[live] using instance ${payload.instances[0].projectName}@${port}`);
  });

  after(async () => {
    // Best-effort cleanup — the probe object must not survive the run.
    try {
      await client.callTool("unity_gameobject_delete", { path: PROBE_NAME, force: true, port });
    } catch {
      /* the probe may never have been created */
    }
    await client.close();
  });

  test("knowledge is served locally while a real editor is connected", async () => {
    const res = await client.callTool("unity_knowledge", { tool: "unity_component_add" });
    assert.equal(res.isError, false);
    assert.match(res.payloadText, /ComponentTools\.addComponent/);
    assert.match(res.payloadText, /componentType/);
  });

  test("editor_ping / scene_info round-trip against the real plugin", async () => {
    const ping = await client.callTool("unity_editor_ping", { port });
    assert.equal(ping.isError, false, `ping failed: ${ping.payloadText}`);
    const scene = await client.callTool("unity_scene_info", { port });
    assert.equal(scene.isError, false, `scene_info failed: ${scene.payloadText}`);
    console.error(`[live] scene: ${JSON.stringify(scene.payload?.data?.name ?? scene.payload).slice(0, 120)}`);
  });

  test("a guide-driven call sequence actually modifies the scene", async () => {
    // Step 1 of the guide's own workflow: create the object.
    const created = await client.callTool("unity_gameobject_create", { name: PROBE_NAME, port });
    assert.equal(created.isError, false, `create failed: ${created.payloadText}`);

    // Step 2, exactly as the guide describes it ("addComponent 'Rigidbody'").
    const added = await client.callTool("unity_component_add", {
      gameObjectPath: PROBE_NAME,
      componentType: "Rigidbody",
      port,
    });
    assert.equal(added.isError, false, `component_add failed: ${added.payloadText}`);

    // Step 3: read it back to prove the call had an effect.
    const props = await client.callTool("unity_component_get_properties", {
      gameObjectPath: PROBE_NAME,
      componentType: "Rigidbody",
      port,
    });
    assert.equal(props.isError, false, `get_properties failed: ${props.payloadText}`);
    console.error(`[live] Rigidbody round-trip: ${props.payloadText.slice(0, 160)}`);
  });

  test("a failing call carries the knowledge hint, and the hint resolves", async () => {
    const failed = await client.callTool("unity_component_add", {
      gameObjectPath: "NoSuchObject_Leeheisen",
      componentType: "Rigidbody",
      port,
    });
    const text = failed.blocks.map((b) => b.text || "").join("\n");
    assert.equal(failed.isError, true, "the call must be flagged as a failure");
    assert.match(text, /Common causes/, "the knowledge hint is attached");
    assert.match(text, /unity_knowledge\(tool:"unity_component_add"\)/);

    // The pointer the hint gives must return a guide with the matching error entry.
    const guide = await client.callTool("unity_knowledge", { tool: "unity_component_add" });
    assert.match(guide.payloadText, /GameObject not found/);
  });

  test("component_properties answers with real Unity component data", async () => {
    const res = await client.callTool("unity_knowledge", { topic: "component_properties", query: "Rigidbody mass" });
    assert.match(res.payloadText, /mass/);
  });
});
