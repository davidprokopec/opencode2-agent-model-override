import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type FileSystem, parentDirectory } from "./store.ts"

/**
 * The real filesystem.
 *
 * `writeAtomic` writes a temporary sibling and renames it over the target, so
 * a concurrently starting OpenCode never reads a half-written document.
 */
export const fileSystem: FileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 })
    // `mode` only applies when mkdir creates the final component. Tighten a
    // pre-existing plugin-owned directory as well.
    await chmod(path, 0o700)
  },
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8")
    } catch (cause) {
      if (isMissing(cause)) return undefined
      throw cause
    }
  },
  writeAtomic: async (path, contents) => {
    const temporary = join(parentDirectory(path), `.${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, path)
  },
}

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"
