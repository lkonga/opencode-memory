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
import { createMemory } from "../memory-core.mjs"

// Initialized eagerly at module scope (top-level await) so the paths exist
// before any nested `describe` test runs. A file-level `before()` hook is not
// guaranteed to have run first on every Node version.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-server-"))
const projectDir = path.join(root, "project")
const userRoot = path.join(root, "config", "memories")
await fs.mkdir(projectDir, { recursive: true })
const expectedEngine = createMemory({ projectDir, userRoot })

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
    assert.deepEqual(state.tool.options, { codemode: false })
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
    assert.equal(await fs.readFile(path.join(expectedEngine.sessionRoot("sess-v2"), "plan.md"), "utf8"), "plan\n")
  })
})

describe("strict malformed-input handling at the direct tool handler boundary", () => {
  const malformed = "Error: invalid arguments"
  const inputs = [
    ["null", null],
    ["array", []],
    ["primitive", "view"],
    ["empty object", {}],
    ["numeric command", { command: 7 }],
    ["numeric path", { command: "view", path: 7 }],
    ["numeric file_text", { command: "create", path: "/memories/malformed.md", file_text: 9 }],
    ["numeric old_str", { command: "str_replace", path: "/memories/malformed.md", old_str: 9, new_str: "y" }],
    ["short view_range", { command: "view", path: "/memories/malformed.md", view_range: [1] }],
    ["long view_range", { command: "view", path: "/memories/malformed.md", view_range: [1, 2, 3] }],
    ["NaN view_range", { command: "view", path: "/memories/malformed.md", view_range: [Number.NaN, 2] }],
    ["infinite view_range", { command: "view", path: "/memories/malformed.md", view_range: [1, Number.POSITIVE_INFINITY] }],
    ["fractional view_range", { command: "view", path: "/memories/malformed.md", view_range: [1.5, 2] }],
    ["fractional insert_line", { command: "insert", path: "/memories/malformed.md", insert_line: 1.5, insert_text: "y" }],
    ["NaN insert_line", { command: "insert", path: "/memories/malformed.md", insert_line: Number.NaN, insert_text: "y" }],
    ["numeric old_path", { command: "rename", old_path: 9, new_path: "/memories/malformed2.md" }],
    ["numeric new_path", { command: "rename", old_path: "/memories/malformed.md", new_path: 9 }],
  ]

  test("returns the same fixed text for every malformed shape and never writes", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    await setupMemoryV2(ctx)
    for (const [name, input] of inputs) {
      const result = await state.tool.execute(input, { sessionID: "sess-malformed" })
      assert.equal(result.content, malformed, name)
    }
    assert.equal(await fs.lstat(path.join(userRoot, "malformed.md")).then(() => true, () => false), false)
    assert.equal(await fs.lstat(path.join(userRoot, "malformed2.md")).then(() => true, () => false), false)
    assert.equal(state.tool.options.codemode, false)
  })

  test("keeps valid input contracts and the unknown-command text intact", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    await setupMemoryV2(ctx)
    const created = await state.tool.execute(
      { command: "create", path: "/memories/malformed-ok.md", file_text: "aaa" },
      { sessionID: "sess-malformed" },
    )
    assert.equal(created.content, "Successfully created /memories/malformed-ok.md")
    const overlap = await state.tool.execute(
      { command: "str_replace", path: "/memories/malformed-ok.md", old_str: "aa", new_str: "b" },
      { sessionID: "sess-malformed" },
    )
    assert.match(overlap.content, /Multiple occurrences/)
    assert.equal(await fs.readFile(path.join(userRoot, "malformed-ok.md"), "utf8"), "aaa")
    const unknown = await state.tool.execute({ command: "nope" }, { sessionID: "sess-malformed" })
    assert.equal(unknown.content, "Error: unknown command")
    // An explicit empty old_str keeps its historical, more specific message.
    const emptyOldStr = await state.tool.execute(
      { command: "str_replace", path: "/memories/malformed-ok.md", old_str: "", new_str: "b" },
      { sessionID: "sess-malformed" },
    )
    assert.equal(emptyOldStr.content, "Error: old_str must not be empty")
    assert.equal(await fs.readFile(path.join(userRoot, "malformed-ok.md"), "utf8"), "aaa")
  })
})

describe("system prompt injection through the public V2 session context hook", () => {
  test("registers `context` and appends a SystemPart", async () => {
    await fs.writeFile(path.join(userRoot, "pref.md"), "MEMCTX-218-ZX9\n", "utf8")
    await fs.mkdir(expectedEngine.sessionRoot("sess-hook"), { recursive: true })
    await fs.writeFile(path.join(expectedEngine.sessionRoot("sess-hook"), "plan.md"), "plan\n", "utf8")

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

  test("degrades safely and logs only a sanitized code when context construction fails", async () => {
    const outside = path.join(root, "context-outside")
    const unsafeRoot = path.join(root, "context-symlink")
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, unsafeRoot)
    const messages = []
    const originalError = console.error
    console.error = (...args) => messages.push(args.join(" "))
    try {
      const { ctx, state } = makeContext({ options: { projectDir, userRoot: unsafeRoot, debug_logging: true } })
      const cleanup = await setupMemoryV2(ctx)
      const event = { sessionID: "context-failure", system: [{ type: "text", text: "base" }] }
      await state.hook(event)
      assert.deepEqual(event.system, [{ type: "text", text: "base" }])
      assert.ok(messages.includes("ELOOP"))
      assert.ok(messages.every((message) => /^[A-Z0-9_]{1,24}$/.test(message)))
      assert.doesNotMatch(messages.join("\n"), /context-symlink|context-outside/)
      await cleanup()
    } finally {
      console.error = originalError
    }
  })
})

describe("lifecycle", () => {
  test("disable gate accepts boolean and string false from both options and config", async (t) => {
    const cases = [
      ["options boolean false", { option: false }],
      ["options string false", { option: "false" }],
      ["config boolean false", { config: false }],
      ["config string false", { config: "false" }],
    ]
    for (const [name, value] of cases) await t.test(name, async () => {
      const configDir = await fs.mkdtemp(path.join(root, "disabled-config-"))
      if ("config" in value) {
        await fs.writeFile(path.join(configDir, "execsa-config.json"), JSON.stringify({ memory_tool_enabled: value.config }))
      }
      const options = { projectDir, userRoot, configDir }
      if ("option" in value) options.memory_tool_enabled = value.option
      const { ctx, state } = makeContext({ options })
      const cleanup = await setupMemoryV2(ctx)
      assert.equal(cleanup, undefined)
      assert.equal(state.tool, undefined)
      assert.equal(state.hook, undefined)
    })
  })

  test("enabled control still registers both public surfaces", async () => {
    const configDir = await fs.mkdtemp(path.join(root, "enabled-config-"))
    await fs.writeFile(path.join(configDir, "execsa-config.json"), JSON.stringify({ memory_tool_enabled: true }))
    const { ctx, state } = makeContext({ options: { projectDir, userRoot, configDir, memory_tool_enabled: true } })
    const cleanup = await setupMemoryV2(ctx)
    assert.equal(state.tool?.name, "memory")
    assert.equal(state.hookName, "context")
    await cleanup()
  })

  test("cleanup disposes both registrations", async () => {
    const { ctx, state } = makeContext({ options: { projectDir, userRoot } })
    const cleanup = await setupMemoryV2(ctx)
    await cleanup()
    assert.deepEqual(state.registered.sort(), ["session", "tool"])
  })
})
