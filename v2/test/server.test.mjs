/**
 * Drives `v2/server.mjs` through a fake V2 Plugin.Context so the plugin's
 * registration surface is verified without a running OpenCode server:
 *  - default export shape = { id, setup }      (supervisor.ts PluginModule)
 *  - ctx.tool.transform(draft => draft.add(..)) (promise/tool.ts ToolDraft.add)
 *  - ctx.session.hook("context", cb)            (promise/session.ts SessionHooks.context)
 */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"

import plugin, { PLUGIN_ID, setupMemoryV2 } from "../server.mjs"

// Initialized eagerly at module scope (top-level await) so the paths exist
// before any nested `describe` test runs. A file-level `before()` hook is not
// guaranteed to have run first on every Node version.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-server-"))
const projectDir = path.join(root, "project")
const userRoot = path.join(root, "config", "memories")
await fs.mkdir(projectDir, { recursive: true })

function makeContext(overrides = {}) {
  const state = { tool: undefined, hook: undefined, hookName: undefined, registered: [] }
  const ctx = {
    options: overrides.options ?? {},
    location: { directory: projectDir },
    tool: {
      transform: async (callback) => {
        const draft = { add: (tool) => (state.tool = tool) }
        callback(draft)
        const registration = { dispose: async () => { state.registered.push("tool") } }
        return registration
      },
    },
    session: {
      hook: async (name, callback) => {
        state.hookName = name
        state.hook = callback
        return { dispose: async () => { state.registered.push("session") } }
      },
    },
  }
  return { ctx, state }
}

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("V2 plugin module contract", () => {
  test("exposes the `{ id, setup }` default export the V2 supervisor decodes", () => {
    assert.equal(typeof plugin.id, "string")
    assert.equal(plugin.id, PLUGIN_ID)
    assert.equal(typeof plugin.setup, "function")
    assert.equal(plugin.setup, setupMemoryV2)
    assert.equal("effect" in plugin, false)
  })
})

describe("tool registration through the public V2 tool domain", () => {
  test("adds a `memory` tool and executes the read/write seam", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    await setupMemoryV2(ctx)

    assert.ok(state.tool, "draft.add must register a tool")
    assert.equal(state.tool.name, "memory")
    assert.equal(state.tool.input.type, "object")
    assert.equal(typeof state.tool.execute, "function")

    const created = await state.tool.execute(
      { command: "create", path: "/memories/v2.md", file_text: "HELLO-218\n" },
      { sessionID: "sess-v2" },
    )
    assert.equal(created.content, "Successfully created /memories/v2.md")
    assert.equal(await fs.readFile(path.join(userRoot, "v2.md"), "utf8"), "HELLO-218\n")

    const viewed = await state.tool.execute({ command: "view", path: "/memories/v2.md" }, { sessionID: "sess-v2" })
    assert.match(viewed.content, /HELLO-218/)

    const session = await state.tool.execute(
      { command: "create", path: "/memories/session/plan.md", file_text: "plan\n" },
      { sessionID: "sess-v2" },
    )
    assert.equal(session.content, "Successfully created /memories/session/plan.md")
    assert.equal(await fs.readFile(path.join(userRoot, "session", "sess-v2", "plan.md"), "utf8"), "plan\n")
  })
})

describe("system prompt injection through the public V2 session context hook", () => {
  test("registers `context` and appends a SystemPart", async () => {
    await fs.writeFile(path.join(userRoot, "pref.md"), "MEMCTX-218-ZX9\n", "utf8")
    await fs.mkdir(path.join(userRoot, "session", "sess-hook"), { recursive: true })
    await fs.writeFile(path.join(userRoot, "session", "sess-hook", "plan.md"), "plan\n", "utf8")

    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    await setupMemoryV2(ctx)

    assert.equal(state.hookName, "context")
    assert.equal(typeof state.hook, "function")

    const event = { sessionID: "sess-hook", agent: "build", system: [{ type: "text", text: "base prompt" }] }
    await state.hook(event)

    assert.equal(event.system.length, 2)
    assert.equal(event.system[0].text, "base prompt")
    assert.equal(event.system[1].type, "text")
    assert.match(event.system[1].text, /<userMemory>/)
    assert.match(event.system[1].text, /MEMCTX-218-ZX9/)
    assert.match(event.system[1].text, /<sessionMemory>/)
    assert.match(event.system[1].text, /\/memories\/session\/plan\.md/)
  })

  test("skips execsa subagent sessions and unknown sessions", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    await setupMemoryV2(ctx)

    const subagent = {
      sessionID: "sess-hook",
      system: [{ type: "text", text: "You are an execution-focused subagent." }],
    }
    await state.hook(subagent)
    assert.equal(subagent.system.length, 1)

    const noSession = { sessionID: undefined, system: [] }
    await state.hook(noSession)
    assert.equal(noSession.system.length, 0)
  })
})

describe("lifecycle", () => {
  test("disable gate returns no registrations", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot, memory_tool_enabled: false } })
    const cleanup = await setupMemoryV2(ctx)
    assert.equal(cleanup, undefined)
    assert.equal(state.tool, undefined)
    assert.equal(state.hook, undefined)
  })

  test("cleanup disposes both registrations", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    const cleanup = await setupMemoryV2(ctx)
    await cleanup()
    assert.deepEqual(state.registered.sort(), ["session", "tool"])
  })
})
