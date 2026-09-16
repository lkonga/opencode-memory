import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createMemory } from "../memory-core.mjs"

export async function makeCase(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-test-"))
  const projectDir = path.join(root, "project")
  const userRoot = path.join(root, "config", "memories")
  await fs.mkdir(projectDir, { recursive: true })
  const engine = createMemory({ projectDir, userRoot, ...options })
  t.after(async () => {
    engine.stopCleanup()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, projectDir, userRoot, engine }
}

export const exists = (target) => fs.lstat(target).then(() => true, () => false)
export const mode = async (target) => (await fs.stat(target)).mode & 0o777
export const tempNames = async (dir) =>
  (await fs.readdir(dir)).filter((name) => name.startsWith(".memory-tmp-"))
