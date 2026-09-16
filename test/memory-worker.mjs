import fs from "node:fs/promises"

const payload = JSON.parse(process.argv[2])
const { createMemory } = await import(payload.module)

const exists = (target) => fs.lstat(target).then(() => true, () => false)
const engine = createMemory({
  projectDir: payload.projectDir,
  userRoot: payload.userRoot,
  beforeCommit: payload.pause ? async ({ phase }) => {
    if (phase !== "before-verify") return
    await fs.writeFile(payload.ready, "ready")
    while (!await exists(payload.gate)) await new Promise((resolve) => setTimeout(resolve, 5))
  } : undefined,
})

const result = await engine.runCommand(payload.args, payload.sessionID)
process.stdout.write(JSON.stringify(result))
