import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import * as Node from "../src/node.ts"
import * as Store from "../src/store.ts"

const path = "/data/opencode2-agent-model-override/overrides.json"

/** A version 1 document: one override map for the installation, owned by no session. */
const legacy = '{"version":1,"overrides":{"build":"anthropic/claude-sonnet-4-5"}}'

/**
 * An in-memory `Store.FileSystem` honouring the same contract as
 * `src/node.ts`: a missing file reads as `undefined` rather than rejecting,
 * and `writeAtomic` is all or nothing.
 *
 * `delay` widens the window between a read and its write, which is what the
 * concurrency tests need to observe a lost update.
 */
const makeMemoryFileSystem = (
  options: { readonly seed?: Record<string, string>; readonly delay?: boolean } = {},
) => {
  const files = new Map(Object.entries(options.seed ?? {}))
  const calls = { mkdir: [] as Array<string>, writeAtomic: [] as Array<string> }
  let failWrite: string | undefined

  const fs: Store.FileSystem = {
    mkdir: async (target) => {
      calls.mkdir.push(target)
    },
    readFile: async (target) => files.get(target),
    writeAtomic: async (target, contents) => {
      if (options.delay === true) await Promise.resolve()
      calls.writeAtomic.push(target)
      // Rejecting before touching the map is what an atomic replacement does
      // on failure: the previous document is still whole on disk.
      if (failWrite !== undefined) throw new Error(failWrite)
      files.set(target, contents)
    },
  }

  return { fs, files, calls, failNextWrites: (reason: string) => (failWrite = reason) }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect)

describe("Store.directory / Store.file", () => {
  test("honours XDG_STATE_HOME", () => {
    expect(Store.directory({ XDG_STATE_HOME: "/data" })).toBe(
      "/data/opencode2-agent-model-override",
    )
    expect(Store.file({ XDG_STATE_HOME: "/data" })).toBe(path)
  })

  test("falls back to ~/.local/state when unset or blank", () => {
    const expected = join(homedir(), ".local", "state", "opencode2-agent-model-override")
    expect(Store.directory({})).toBe(expected)
    expect(Store.directory({ XDG_STATE_HOME: "   " })).toBe(expected)
  })

  test("finds the parent of POSIX and Windows state files", () => {
    expect(Store.parentDirectory("/state/plugin/overrides.json")).toBe("/state/plugin")
    expect(Store.parentDirectory("C:\\state\\plugin\\overrides.json")).toBe("C:\\state\\plugin")
  })
})

describe("Store.read", () => {
  test("a missing file reads as empty rather than failing", async () => {
    const { fs } = makeMemoryFileSystem()
    const exit = await run(Store.make(fs, path).read)
    expect(exit).toEqual(Exit.succeed(Store.empty))
  })

  test("reads back what write persisted", async () => {
    const { fs } = makeMemoryFileSystem()
    const store = Store.make(fs, path)
    const state: Store.State = {
      version: 2,
      sessions: {
        ses_a: { build: "anthropic/claude-sonnet-4-5", explore: "openai/gpt-5.1#thinking" },
        ses_b: { build: "openai/gpt-5.1" },
      },
    }

    expect(Exit.isSuccess(await run(store.write(state)))).toBe(true)
    const exit = await run(store.read)
    expect(exit).toEqual(Exit.succeed(state))
  })

  test("survives a process restart: a second store over the same disk sees it", async () => {
    const { fs } = makeMemoryFileSystem()
    const state: Store.State = { version: 2, sessions: { ses_a: { build: "openai/gpt-5.1" } } }
    await run(Store.make(fs, path).write(state))

    const exit = await run(Store.make(fs, path).read)
    expect(exit).toEqual(Exit.succeed(state))
  })

  for (const [label, contents] of [
    ["a version 1 document, whose overrides belonged to no session", legacy],
    ["an empty version 1 document", '{"version":1,"overrides":{}}'],
  ] as const) {
    test(`reads ${label} as empty, so no session inherits it`, async () => {
      const { fs } = makeMemoryFileSystem({ seed: { [path]: contents } })
      expect(await run(Store.make(fs, path).read)).toEqual(Exit.succeed(Store.empty))
    })
  }

  test("the next write replaces a version 1 document with a version 2 one", async () => {
    const { fs, files } = makeMemoryFileSystem({ seed: { [path]: legacy } })
    const store = Store.make(fs, path)

    await run(store.write({ version: 2, sessions: { ses_a: { build: "openai/gpt-5.1" } } }))

    expect(files.get(path)).toContain('"version": 2')
    expect(files.get(path)).not.toContain("claude-sonnet-4-5")
    expect(await run(store.read)).toEqual(
      Exit.succeed({ version: 2, sessions: { ses_a: { build: "openai/gpt-5.1" } } }),
    )
  })

  for (const [label, contents] of [
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["an unknown version", '{"version":7,"sessions":{}}'],
    ["a version 2 document with no sessions key", '{"version":2,"overrides":{}}'],
    ["a version 1 document with no overrides key", '{"version":1}'],
    ["non-string override values", '{"version":2,"sessions":{"ses_a":{"build":42}}}'],
    ["overrides that are not grouped by session", '{"version":2,"sessions":{"build":"openai/x"}}'],
  ] as const) {
    test(`fails with a reportable StoreError for ${label}`, async () => {
      const { fs } = makeMemoryFileSystem({ seed: { [path]: contents } })
      const exit = await run(Store.make(fs, path).read)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = await Effect.runPromise(Store.make(fs, path).read.pipe(Effect.flip))
      expect(error.path).toBe(path)
      expect(error.display).toContain(path)
    })
  }
})

describe("Store.write", () => {
  test("creates the parent directory and replaces atomically", async () => {
    const { fs, calls } = makeMemoryFileSystem()
    await run(Store.make(fs, path).write(Store.empty))

    expect(calls.mkdir).toEqual(["/data/opencode2-agent-model-override"])
    expect(calls.writeAtomic).toEqual([path])
  })

  test("writes a trailing newline and stable indentation", async () => {
    const { fs, files } = makeMemoryFileSystem()
    await run(
      Store.make(fs, path).write({ version: 2, sessions: { ses_a: { build: "openai/gpt-5.1" } } }),
    )

    expect(files.get(path)).toBe(
      `{\n  "version": 2,\n  "sessions": {\n    "ses_a": {\n      "build": "openai/gpt-5.1"\n    }\n  }\n}\n`,
    )
  })

  test("a failed write leaves the previous document whole", async () => {
    const previous: Store.State = { version: 2, sessions: { ses_a: { build: "openai/gpt-5.1" } } }
    const { fs, failNextWrites } = makeMemoryFileSystem({
      seed: { [path]: `${JSON.stringify(previous, null, 2)}\n` },
    })
    const store = Store.make(fs, path)
    failNextWrites("ENOSPC: no space left on device")

    const exit = await run(
      store.write({ version: 2, sessions: { ses_a: { build: "anthropic/other" } } }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await run(store.read)).toEqual(Exit.succeed(previous))
  })
})

describe("Node.fileSystem", () => {
  const withTemporaryDirectory = async (body: (directory: string) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), "override-store-"))
    try {
      await body(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  test("reads a missing file as undefined", async () => {
    await withTemporaryDirectory(async (directory) => {
      expect(await Node.fileSystem.readFile(join(directory, "absent.json"))).toBeUndefined()
    })
  })

  test("round trips through the real disk and replaces an existing file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = join(directory, "nested", "overrides.json")
      await Node.fileSystem.mkdir(join(directory, "nested"))
      const store = Store.make(Node.fileSystem, target)

      const first: Store.State = { version: 2, sessions: { ses_a: { build: "openai/gpt-5.1" } } }
      await Effect.runPromise(store.write(first))
      expect(await Effect.runPromise(store.read)).toEqual(first)

      const second: Store.State = {
        version: 2,
        sessions: { ses_b: { explore: "anthropic/sonnet" } },
      }
      await Effect.runPromise(store.write(second))
      expect(await Effect.runPromise(store.read)).toEqual(second)
    })
  })

  test("leaves no temporary file behind, so the replacement was a rename", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = join(directory, "overrides.json")
      await Node.fileSystem.writeAtomic(target, "{}\n")
      await Node.fileSystem.writeAtomic(target, '{"version":2}\n')

      expect((await readdir(directory)).sort()).toEqual(["overrides.json"])
    })
  })

  test("keeps the plugin directory and state private from other local users", async () => {
    if (process.platform === "win32") return
    await withTemporaryDirectory(async (directory) => {
      const state = join(directory, "state")
      const target = join(state, "overrides.json")
      await Node.fileSystem.mkdir(state)
      await Node.fileSystem.writeAtomic(target, "{}\n")

      expect((await stat(state)).mode & 0o777).toBe(0o700)
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    })
  })

  test("a concurrent reader never observes a partial document", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = join(directory, "overrides.json")
      const small = `${JSON.stringify({ version: 2, sessions: {} })}\n`
      // Large enough that a non-atomic write would be observably partial.
      const large = `${JSON.stringify({
        version: 2,
        sessions: Object.fromEntries(
          Array.from({ length: 2000 }, (_, index) => [`ses_${index}`, { build: "openai/gpt-5.1" }]),
        ),
      })}\n`
      await Node.fileSystem.writeAtomic(target, small)

      const writes = (async () => {
        for (let round = 0; round < 20; round += 1) {
          await Node.fileSystem.writeAtomic(target, round % 2 === 0 ? large : small)
        }
      })()

      const seen: Array<number> = []
      while (seen.length < 40) {
        const contents = await readFile(target, "utf8")
        // Throws if a reader ever caught a half-written file.
        const parsed: unknown = JSON.parse(contents)
        expect(parsed).toBeDefined()
        seen.push(contents.length)
      }
      await writes
    })
  })
})
