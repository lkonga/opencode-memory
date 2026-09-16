# opencode-memory — V2 port

V2 implementation of the `memory` tool + memory system-prompt injection, built
**only** on public V2 plugin APIs. The V1 implementation (`../index.ts`,
`../index.test.ts`, `../package.json`, `../README.md`) is untouched and still
loads as the V1 backend `file:///home/lkonga/codes/opencode-plugins/opencode-memory`.

## Layout

| File | Purpose |
|------|---------|
| `server.mjs` | V2 plugin entry (`export default { id, setup }`) — wiring only |
| `memory-core.mjs` | Pure engine: scopes, path resolution, all read/write commands, context block |
| `test/memory-core.test.mjs` | Engine tests (scopes, CRUD, traversal, context) |
| `test/server.test.mjs` | V2 API-surface tests (tool registration + context hook) |
| `test/codemode-partition.test.mjs` | Effective-registry tests (direct vs Code Mode partition, direct dispatch) |

## Install (V2)

V2 reads the `plugins` key (not V1's `plugin`) in `opencode.json`/`opencode.jsonc`
(`packages/core/src/config/normalize.ts:173-178`). Use `cli.json` for TUI
plugins; V2 has no `tui.json`.

```jsonc
{
  "plugins": [
    "/home/lkonga/codes/opencode-plugins/opencode-memory/v2"
  ]
}
```

The plugin directory's `package.json` `main` resolves to `server.mjs`, which
V2 imports as a promise plugin and adapts via `PluginPromise.fromPromise`
(`packages/core/src/plugin/supervisor.ts:18-30` in the pinned checkout;
`packages/core/src/plugin/module.ts:60-71` in `upstream/v2`).

## API mapping (V1 → V2)

| V1 | V2 public API | Citation (pinned `opencode-v2-scrollfix`) |
|----|---------------|-------------------------------------------|
| `tool: { memory: tool({...}) }` | `ctx.tool.transform(draft => draft.add(tool))` | `packages/plugin/src/promise/tool.ts:24-28,58-61`; host mapping `packages/core/src/plugin/host.ts:303-312` |
| `experimental.chat.system.transform` | `ctx.session.hook("context", event => event.system.push(...))` | `packages/plugin/src/promise/session.ts:9-16,33-44`; trigger `packages/core/src/session/model-request.ts:210-235` |
| `PluginInput.directory` | `ctx.location.directory` (guarded; falls back to `process.cwd()`) | `upstream/v2` `packages/plugin/src/promise/plugin.ts:27` + `packages/plugin/src/promise/adapter.ts:291` |
| zod `args` | plain JSON Schema `input` (passed through untouched) | `packages/core/src/tool/runtime.ts:34-40,89-94` |

The context hook receives a mutable `system: Array<SystemPart>`, where a
`SystemPart` is `{ type: "text", text }` (`packages/ai/src/schema/messages.ts:14-25`).

### Direct (native) exposure

`memory` is registered with `options: { codemode: false }`. `Tool.Snapshot`
partitions the active registrations on that flag
(`packages/core/src/tool.ts:216-231`):

- `options.codemode === false` → a **direct** model tool definition, dispatched
  by name (`packages/core/src/tool.ts:248-249`)
- omitted `options` → a **Code Mode** catalog entry, reachable only through the
  synthetic `execute` tool

So the model calls `memory` directly; no `execute`/Code Mode round-trip is
required, and `memory` is absent from the Code Mode catalog. This is the V2
equivalent of V1's native `tool: { memory: ... }` exposure.

## Tests

Lightweight, dependency-free (`node:test`), no V2 source or network required:

```bash
cd v2 && node --test test/*.test.mjs
```

## Runtime smoke (verified)

Private server, isolated config + data (no shared/V1 state):

```bash
OPENCODE_CONFIG_DIR=/tmp/oc2-218-config XDG_DATA_HOME=/tmp/oc2-218-data \
  oc2 run --standalone --model omniroute/om-dsv4f '<prompt>'
```

Evidence: `msg="loading plugin" ... entrypoint=file://.../opencode-memory/.worktrees/memory/v2/server.mjs`,
tool result `Successfully created /memories/session/smoke-218.md`, and the model
reporting the seeded `<userMemory>` token.
