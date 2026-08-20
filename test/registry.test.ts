import { describe, expect, test } from "bun:test"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import { Effect, Exit, Fiber, Option } from "effect"
import * as ModelRef from "../src/model.ts"
import * as Registry from "../src/registry.ts"
import * as Store from "../src/store.ts"
import { session } from "./support.ts"

/**
 * A document of its own per test.
 *
 * Registries coordinate through a lock keyed on the path, so tests that are
 * meant to be independent have to be on paths of their own; the ones about two
 * registries sharing state pass the same path deliberately.
 */
let sequence = 0
const nextPath = (): string => {
  sequence += 1
  return `/data/registry-${sequence}/overrides.json`
}

/** The two sessions every isolation test here plays off against each other. */
const a = session("ses_a")
const b = session("ses_b")

const makeMemoryFileSystem = (
  options: { readonly seed?: string; readonly delay?: boolean; readonly path?: string } = {},
) => {
  const path = options.path ?? nextPath()
  const files = new Map<string, string>(options.seed === undefined ? [] : [[path, options.seed]])
  const fs: Store.FileSystem = {
    mkdir: async () => {},
    readFile: async (target) => files.get(target),
    writeAtomic: async (target, contents) => {
      // Yielding to the microtask queue between the read and the write is what
      // makes a lost update observable if mutations are not serialized.
      if (options.delay === true) await Promise.resolve()
      files.set(target, contents)
    },
  }
  return { fs, files, path }
}

/** Reads the persisted session map without going through the store's decode. */
const persistedSessions = (files: Map<string, string>): Record<string, Record<string, string>> => {
  const contents = [...files.values()][0]
  if (contents === undefined) return {}
  const parsed: unknown = JSON.parse(contents)
  if (typeof parsed !== "object" || parsed === null || !("sessions" in parsed)) return {}
  const sessions: unknown = parsed.sessions
  if (typeof sessions !== "object" || sessions === null) return {}
  const result: Record<string, Record<string, string>> = {}
  for (const [sessionID, overrides] of Object.entries(sessions)) {
    if (typeof overrides !== "object" || overrides === null) continue
    const decoded: Record<string, string> = {}
    for (const [agent, model] of Object.entries(overrides)) {
      if (typeof model === "string") decoded[agent] = model
    }
    result[sessionID] = decoded
  }
  return result
}

/** What one session holds on disk. */
const persistedOverrides = (
  files: Map<string, string>,
  sessionID: Session.ID = a,
): Record<string, string> => persistedSessions(files)[sessionID] ?? {}

const document = (sessions: Record<string, Record<string, string>>): string =>
  `${JSON.stringify({ version: 2, sessions }, null, 2)}\n`

const ref = (input: string): Model.Ref => Effect.runSync(ModelRef.parse(input))

const makeRegistry = (options: { readonly seed?: string; readonly delay?: boolean } = {}) => {
  const memory = makeMemoryFileSystem(options)
  const store = Store.make(memory.fs, memory.path)
  return Effect.runPromise(Registry.make(store)).then((registry) => ({ registry, ...memory }))
}

/** One session's overrides as `agent -> model`, which is what most assertions compare. */
const listed = async (
  registry: Registry.Interface,
  sessionID: Session.ID,
): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await Effect.runPromise(registry.list(sessionID))).map((override) => [
      override.agent,
      ModelRef.format(override.model),
    ]),
  )

describe("Registry.make", () => {
  test("no persisted state means no overrides", async () => {
    const { registry } = await makeRegistry()
    expect(await Effect.runPromise(registry.list(a))).toEqual([])
    expect(await Effect.runPromise(registry.listAll)).toEqual([])
  })

  for (const [label, seed] of [
    ["invalid JSON", "{not json"],
    ["an unknown version", '{"version":7,"sessions":{"ses_a":{"build":"openai/gpt-5.1"}}}'],
    ["a wrong shape", '{"sessions":[]}'],
  ] as const) {
    test(`${label} falls back to empty instead of failing the load`, async () => {
      const { registry } = await makeRegistry({ seed })
      expect(await Effect.runPromise(registry.list(a))).toEqual([])
    })
  }

  test("a version 1 document gives no session any override", async () => {
    const { registry } = await makeRegistry({
      seed: `${JSON.stringify({ version: 1, overrides: { build: "openai/gpt-5.1" } }, null, 2)}\n`,
    })

    expect(await Effect.runPromise(registry.list(a))).toEqual([])
    expect(await Effect.runPromise(registry.list(b))).toEqual([])
    expect(await Effect.runPromise(registry.listAll)).toEqual([])
  })

  test("a version 1 document is replaced by a session keyed one on the next write", async () => {
    const { registry, files } = await makeRegistry({
      seed: `${JSON.stringify({ version: 1, overrides: { build: "openai/gpt-5.1" } })}\n`,
    })

    await Effect.runPromise(registry.set(a, "explore", ref("openai/gpt-5.1")))

    expect(persistedSessions(files)).toEqual({ ses_a: { explore: "openai/gpt-5.1" } })
  })

  test("skips an unparsable model reference but keeps the usable ones", async () => {
    const { registry } = await makeRegistry({
      seed: document({ ses_a: { build: "not-a-reference", explore: "openai/gpt-5.1" } }),
    })

    const overrides = await Effect.runPromise(registry.list(a))
    expect(overrides.map((override) => override.agent)).toEqual(["explore"])
    expect(ModelRef.format(overrides[0]?.model ?? ref("openai/none"))).toBe("openai/gpt-5.1")
  })

  test("a corrupt document is replaced on the next successful write", async () => {
    const { registry, files } = await makeRegistry({ seed: "{not json" })
    await Effect.runPromise(registry.set(a, "build", ref("openai/gpt-5.1")))

    expect(persistedOverrides(files)).toEqual({ build: "openai/gpt-5.1" })
  })
})

describe("Registry session scope", () => {
  test("an override one session set is invisible to another", async () => {
    const { registry } = await makeRegistry()

    await Effect.runPromise(registry.set(a, "build", ref("openai/gpt-5.1")))

    expect(await listed(registry, a)).toEqual({ build: "openai/gpt-5.1" })
    expect(await listed(registry, b)).toEqual({})
  })

  test("two sessions override one agent to different models, side by side", async () => {
    const { registry, files } = await makeRegistry()

    await Effect.runPromise(registry.set(a, "build", ref("openai/gpt-5.1")))
    await Effect.runPromise(registry.set(b, "build", ref("anthropic/claude-sonnet-4-5")))

    expect(await listed(registry, a)).toEqual({ build: "openai/gpt-5.1" })
    expect(await listed(registry, b)).toEqual({ build: "anthropic/claude-sonnet-4-5" })
    expect(persistedSessions(files)).toEqual({
      ses_a: { build: "openai/gpt-5.1" },
      ses_b: { build: "anthropic/claude-sonnet-4-5" },
    })
  })

  test("listAll reports every session's overrides with the session they belong to", async () => {
    const { registry } = await makeRegistry({
      seed: document({
        ses_b: { review: "openai/gpt-5.1" },
        ses_a: { explore: "anthropic/claude-haiku-4-5", build: "openai/gpt-5.1#high" },
      }),
    })

    expect(
      (await Effect.runPromise(registry.listAll)).map(
        (override) => `${override.sessionID}/${override.agent}=${ModelRef.format(override.model)}`,
      ),
    ).toEqual([
      "ses_a/build=openai/gpt-5.1#high",
      "ses_a/explore=anthropic/claude-haiku-4-5",
      "ses_b/review=openai/gpt-5.1",
    ])
  })

  test("clear touches only the session that asked for it", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({ ses_a: { build: "openai/gpt-5.1" }, ses_b: { build: "openai/gpt-5.1" } }),
    })

    const cleared = await Effect.runPromise(registry.clear(a, "build"))

    expect(Option.isSome(cleared)).toBe(true)
    expect(await listed(registry, a)).toEqual({})
    expect(await listed(registry, b)).toEqual({ build: "openai/gpt-5.1" })
    // The emptied session is gone rather than left as an empty key.
    expect(persistedSessions(files)).toEqual({ ses_b: { build: "openai/gpt-5.1" } })
  })

  test("clearing an agent another session overrode reports nothing to clear", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({ ses_b: { build: "openai/gpt-5.1" } }),
    })

    expect(await Effect.runPromise(registry.clear(a, "build"))).toEqual(Option.none())
    expect(persistedSessions(files)).toEqual({ ses_b: { build: "openai/gpt-5.1" } })
  })

  test("clearAll empties only the calling session", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({
        ses_a: { build: "openai/gpt-5.1", explore: "openai/gpt-5.1" },
        ses_b: { review: "anthropic/claude-haiku-4-5" },
      }),
    })

    const cleared = await Effect.runPromise(registry.clearAll(a))

    expect(cleared.map((override) => override.agent)).toEqual(["build", "explore"])
    expect(persistedSessions(files)).toEqual({ ses_b: { review: "anthropic/claude-haiku-4-5" } })
    expect(await listed(registry, b)).toEqual({ review: "anthropic/claude-haiku-4-5" })
  })

  test("clearAll for a session with nothing set neither fails nor writes", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({ ses_b: { build: "openai/gpt-5.1" } }),
    })

    expect(await Effect.runPromise(registry.clearAll(a))).toEqual([])
    expect(persistedSessions(files)).toEqual({ ses_b: { build: "openai/gpt-5.1" } })
  })
})

describe("Registry.set / clear / clearAll", () => {
  test("set persists the canonical reference and publishes it in memory", async () => {
    const { registry, files } = await makeRegistry()

    await Effect.runPromise(registry.set(a, "build", ref("anthropic/claude-sonnet-4-5#thinking")))

    expect(persistedOverrides(files)).toEqual({
      build: "anthropic/claude-sonnet-4-5#thinking",
    })
    expect(await listed(registry, a)).toEqual({ build: "anthropic/claude-sonnet-4-5#thinking" })
  })

  test("set twice for one agent replaces rather than accumulates", async () => {
    const { registry, files } = await makeRegistry()

    await Effect.runPromise(registry.set(a, "build", ref("openai/gpt-5.1")))
    await Effect.runPromise(registry.set(a, "build", ref("anthropic/claude-sonnet-4-5")))

    expect(persistedOverrides(files)).toEqual({ build: "anthropic/claude-sonnet-4-5" })
    expect((await Effect.runPromise(registry.list(a))).length).toBe(1)
  })

  test("a new registry over the same disk sees the session's overrides", async () => {
    const memory = makeMemoryFileSystem()
    const first = await Effect.runPromise(Registry.make(Store.make(memory.fs, memory.path)))
    await Effect.runPromise(first.set(a, "build", ref("openai/gpt-5.1")))

    const second = await Effect.runPromise(Registry.make(Store.make(memory.fs, memory.path)))
    expect(await listed(second, a)).toEqual({ build: "openai/gpt-5.1" })
    expect(await listed(second, b)).toEqual({})
  })

  test("clear removes one override and reports what it removed", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({ ses_a: { build: "openai/gpt-5.1", explore: "anthropic/claude-haiku-4-5" } }),
    })

    const cleared = await Effect.runPromise(registry.clear(a, "build"))
    expect(Option.isSome(cleared)).toBe(true)
    if (Option.isSome(cleared)) {
      expect(ModelRef.format(cleared.value.model)).toBe("openai/gpt-5.1")
    }
    expect(persistedOverrides(files)).toEqual({ explore: "anthropic/claude-haiku-4-5" })
    expect((await Effect.runPromise(registry.list(a))).map((o) => o.agent)).toEqual(["explore"])
  })

  test("clearing an agent that was never overridden changes nothing", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({ ses_a: { build: "openai/gpt-5.1" } }),
    })

    const cleared = await Effect.runPromise(registry.clear(a, "explore"))
    expect(cleared).toEqual(Option.none())
    expect(persistedOverrides(files)).toEqual({ build: "openai/gpt-5.1" })
  })

  test("clearAll empties the session and returns everything it removed", async () => {
    const { registry, files } = await makeRegistry({
      seed: document({ ses_a: { build: "openai/gpt-5.1", explore: "anthropic/claude-haiku-4-5" } }),
    })

    const cleared = await Effect.runPromise(registry.clearAll(a))
    expect(cleared.map((override) => override.agent)).toEqual(["build", "explore"])
    expect(persistedSessions(files)).toEqual({})
    expect(await Effect.runPromise(registry.list(a))).toEqual([])
  })

  test("clearAll with nothing set neither fails nor writes", async () => {
    const { registry, files } = await makeRegistry()

    expect(await Effect.runPromise(registry.clearAll(a))).toEqual([])
    expect(files.size).toBe(0)
  })

  test("a failed write leaves nothing behind to report", async () => {
    const path = nextPath()
    const store: Store.Interface = {
      path,
      read: Effect.succeed(Store.empty),
      write: () =>
        Effect.fail(
          new Store.StoreError({ operation: "writeAtomic", path, reason: "read-only file system" }),
        ),
    }
    const registry = await Effect.runPromise(Registry.make(store))

    const exit = await Effect.runPromiseExit(registry.set(a, "build", ref("openai/gpt-5.1")))
    expect(Exit.isFailure(exit)).toBe(true)

    // Nothing may claim an override that never reached the disk.
    expect(await Effect.runPromise(registry.list(a))).toEqual([])
  })
})

describe("Registry concurrency", () => {
  test("an interrupted write settles before the next mutation gets the permit", async () => {
    let persisted = Store.empty
    let writes = 0
    let releaseFirst: (() => void) | undefined
    let announceStarted: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      announceStarted = resolve
    })

    const store: Store.Interface = {
      path: nextPath(),
      read: Effect.sync(() => persisted),
      write: (next) =>
        Effect.promise(() => {
          writes += 1
          if (writes !== 1) {
            persisted = next
            return Promise.resolve()
          }
          announceStarted?.()
          return new Promise<void>((resolve) => {
            releaseFirst = () => {
              persisted = next
              resolve()
            }
          })
        }),
    }
    const registry = await Effect.runPromise(Registry.make(store))

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(registry.set(a, "build", ref("openai/gpt-5.1")))
        yield* Effect.promise(() => firstStarted)

        // Request interruption without waiting for it. The write is deliberately
        // backed by a non-cancellable promise, matching Node's filesystem calls.
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(first))
        const second = yield* Effect.forkChild(
          registry.set(a, "explore", ref("anthropic/claude-sonnet-4-5")),
        )
        yield* Effect.yieldNow

        // The second mutation must still be waiting for the first physical
        // write, even though interruption has already been requested.
        expect(second.pollUnsafe()).toBeUndefined()

        const release = releaseFirst
        if (release === undefined) throw new Error("first write did not expose its release")
        release()
        yield* Fiber.await(interrupted)
        yield* Fiber.join(second)
      }),
    )

    expect(persisted.sessions).toEqual({
      ses_a: { build: "openai/gpt-5.1", explore: "anthropic/claude-sonnet-4-5" },
    })
    expect(await listed(registry, a)).toEqual(persisted.sessions.ses_a ?? {})
  })

  test("concurrent sets all survive", async () => {
    const { registry, files } = await makeRegistry({ delay: true })
    const agents = Array.from({ length: 12 }, (_, index) => `agent-${index}`)

    await Effect.runPromise(
      Effect.all(
        agents.map((agent) => registry.set(a, agent, ref(`openai/model-${agent}`))),
        { concurrency: "unbounded" },
      ),
    )

    expect(Object.keys(persistedOverrides(files)).sort()).toEqual([...agents].sort())
    expect((await Effect.runPromise(registry.list(a))).length).toBe(12)
  })

  test("concurrent sets from two sessions all survive, each under its own key", async () => {
    const { registry, files } = await makeRegistry({ delay: true })

    await Effect.runPromise(
      Effect.all(
        [
          registry.set(a, "build", ref("openai/gpt-5.1")),
          registry.set(b, "build", ref("anthropic/claude-sonnet-4-5")),
          registry.set(a, "explore", ref("openai/gpt-5.1#high")),
          registry.set(b, "review", ref("anthropic/claude-haiku-4-5")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    expect(persistedSessions(files)).toEqual({
      ses_a: { build: "openai/gpt-5.1", explore: "openai/gpt-5.1#high" },
      ses_b: { build: "anthropic/claude-sonnet-4-5", review: "anthropic/claude-haiku-4-5" },
    })
    expect(await listed(registry, a)).toEqual(persistedSessions(files).ses_a ?? {})
    expect(await listed(registry, b)).toEqual(persistedSessions(files).ses_b ?? {})
  })

  test("concurrent set and clear leave memory and disk agreeing", async () => {
    const { registry, files } = await makeRegistry({
      delay: true,
      seed: document({ ses_a: { old: "openai/gpt-5.1" } }),
    })

    await Effect.runPromise(
      Effect.all(
        [
          registry.set(a, "build", ref("openai/gpt-5.1")),
          registry.clear(a, "old"),
          registry.set(a, "explore", ref("anthropic/claude-haiku-4-5")),
          registry.clear(a, "absent").pipe(Effect.asVoid),
          registry.set(a, "plan", ref("openai/gpt-5.1#high")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    const onDisk = persistedOverrides(files)
    expect(Object.keys(onDisk).sort()).toEqual(["build", "explore", "plan"])
    expect(onDisk.old).toBeUndefined()
    expect(await listed(registry, a)).toEqual(onDisk)
  })

  test("the last concurrent set for one agent wins and nothing is lost", async () => {
    const { registry, files } = await makeRegistry({ delay: true })

    await Effect.runPromise(
      Effect.all(
        [
          registry.set(a, "build", ref("openai/gpt-5.1")),
          registry.set(a, "build", ref("anthropic/claude-sonnet-4-5")),
          registry.set(a, "explore", ref("openai/gpt-5.1")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    const onDisk = persistedOverrides(files)
    expect(Object.keys(onDisk).sort()).toEqual(["build", "explore"])
    expect(onDisk.explore).toBe("openai/gpt-5.1")
    expect(typeof onDisk.build).toBe("string")
  })

  /**
   * Two registries over one document, as OpenCode builds them: the plugin is
   * instantiated once per location inside a single service, and each instance
   * makes its own registry over the same file.
   */
  const makeShared = async (options: { readonly seed?: string } = {}) => {
    const memory = makeMemoryFileSystem({ ...options, delay: true })
    const [first, second] = await Promise.all([
      Effect.runPromise(Registry.make(Store.make(memory.fs, memory.path))),
      Effect.runPromise(Registry.make(Store.make(memory.fs, memory.path))),
    ])
    if (first === undefined || second === undefined) throw new Error("no registries")
    return { first, second, files: memory.files }
  }

  test("concurrent sets from two registries over one document all survive", async () => {
    const { first, second, files } = await makeShared()

    await Effect.runPromise(
      Effect.all(
        [
          first.set(a, "build", ref("openai/gpt-5.1")),
          second.set(a, "explore", ref("anthropic/claude-haiku-4-5")),
          first.set(a, "plan", ref("openai/gpt-5.1#high")),
          second.set(a, "review", ref("anthropic/claude-sonnet-4-5")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    const onDisk = persistedOverrides(files)
    expect(Object.keys(onDisk).sort()).toEqual(["build", "explore", "plan", "review"])
    // Neither instance answers from a copy of its own: both read what is there.
    expect(await listed(first, a)).toEqual(onDisk)
    expect(await listed(second, a)).toEqual(onDisk)
  })

  test("two registries writing for different sessions do not lose each other's key", async () => {
    const { first, second, files } = await makeShared()

    await Effect.runPromise(
      Effect.all(
        [
          first.set(a, "build", ref("openai/gpt-5.1")),
          second.set(b, "build", ref("anthropic/claude-sonnet-4-5")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    expect(persistedSessions(files)).toEqual({
      ses_a: { build: "openai/gpt-5.1" },
      ses_b: { build: "anthropic/claude-sonnet-4-5" },
    })
    expect(await listed(second, a)).toEqual({ build: "openai/gpt-5.1" })
    expect(await listed(first, b)).toEqual({ build: "anthropic/claude-sonnet-4-5" })
  })

  test("one session's clearAll racing another session's set keeps both correct", async () => {
    const { first, second, files } = await makeShared({
      seed: document({ ses_a: { build: "openai/gpt-5.1" } }),
    })

    await Effect.runPromise(
      Effect.all(
        [
          first.clearAll(a).pipe(Effect.asVoid),
          second.set(b, "build", ref("anthropic/claude-sonnet-4-5")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    expect(persistedSessions(files)).toEqual({ ses_b: { build: "anthropic/claude-sonnet-4-5" } })
    expect(await listed(first, a)).toEqual({})
    expect(await listed(second, b)).toEqual({ build: "anthropic/claude-sonnet-4-5" })
  })

  test("a clear from one registry is not undone by a set from the other", async () => {
    const { first, second, files } = await makeShared({
      seed: document({ ses_a: { old: "openai/gpt-5.1", kept: "openai/gpt-5.1" } }),
    })

    await Effect.runPromise(
      Effect.all(
        [
          first.clear(a, "old").pipe(Effect.asVoid),
          second.set(a, "build", ref("anthropic/claude-sonnet-4-5")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    const onDisk = persistedOverrides(files)
    expect(Object.keys(onDisk).sort()).toEqual(["build", "kept"])
    expect(await listed(first, a)).toEqual(onDisk)
    expect(await listed(second, a)).toEqual(onDisk)
  })

  test("two registries clearing the same override at once remove it exactly once", async () => {
    const { first, second, files } = await makeShared({
      seed: document({ ses_a: { shared: "openai/gpt-5.1", kept: "openai/gpt-5.1" } }),
    })

    const [x, y] = await Effect.runPromise(
      Effect.all([first.clear(a, "shared"), second.clear(a, "shared")], {
        concurrency: "unbounded",
      }),
    )

    // The lock serializes the two racing clears: exactly one of them still
    // found the override, the other one arrived after it was already gone.
    expect([Option.isSome(x), Option.isSome(y)].filter(Boolean).length).toBe(1)

    const onDisk = persistedOverrides(files)
    expect(onDisk).toEqual({ kept: "openai/gpt-5.1" })
    expect(await listed(first, a)).toEqual(onDisk)
    expect(await listed(second, a)).toEqual(onDisk)
  })

  test(
    "two cross-location registries migrating one legacy document at once never resurrect it " +
      "and never lose either session's write",
    async () => {
      const { first, second, files } = await makeShared({
        seed: `${JSON.stringify({ version: 1, overrides: { build: "openai/gpt-5.1" } })}\n`,
      })

      await Effect.runPromise(
        Effect.all(
          [
            first.set(a, "explore", ref("openai/gpt-5.1")),
            second.set(b, "review", ref("anthropic/claude-sonnet-4-5")),
          ],
          { concurrency: "unbounded" },
        ),
      )

      // The legacy, session-less "build" override belonged to no session and
      // must not resurface under either of theirs, or as a top level key of
      // its own, no matter which write landed on the document first.
      expect(persistedSessions(files)).toEqual({
        ses_a: { explore: "openai/gpt-5.1" },
        ses_b: { review: "anthropic/claude-sonnet-4-5" },
      })
      expect(await listed(first, a)).toEqual({ explore: "openai/gpt-5.1" })
      expect(await listed(second, b)).toEqual({ review: "anthropic/claude-sonnet-4-5" })
      expect(await listed(first, b)).toEqual({ review: "anthropic/claude-sonnet-4-5" })
      expect(await listed(second, a)).toEqual({ explore: "openai/gpt-5.1" })
    },
  )

  test("two registries setting the same agent at once agree on one winner everywhere", async () => {
    const { first, second, files } = await makeShared()

    await Effect.runPromise(
      Effect.all(
        [
          first.set(a, "build", ref("openai/gpt-5.1")),
          second.set(a, "build", ref("anthropic/claude-sonnet-4-5")),
        ],
        { concurrency: "unbounded" },
      ),
    )

    const onDisk = persistedOverrides(files)
    expect(Object.keys(onDisk)).toEqual(["build"])
    // Whichever value won the race, disk and both registries agree on it: no
    // instance is left serving the one that lost.
    expect(await listed(first, a)).toEqual(onDisk)
    expect(await listed(second, a)).toEqual(onDisk)
  })

  test("a registry observes a change another one made, without mutating first", async () => {
    const { first, second } = await makeShared()

    // Both have read the document already, so a copy kept from that read is
    // what a later list would wrongly answer from.
    expect(await listed(first, a)).toEqual({})
    expect(await listed(second, a)).toEqual({})

    await Effect.runPromise(first.set(a, "build", ref("openai/gpt-5.1")))
    expect(await listed(second, a)).toEqual({ build: "openai/gpt-5.1" })

    await Effect.runPromise(second.clearAll(a))
    expect(await listed(first, a)).toEqual({})
  })

  test("clearAll racing a set does not resurrect a stale document", async () => {
    const { registry, files } = await makeRegistry({
      delay: true,
      seed: document({ ses_a: { build: "openai/gpt-5.1", explore: "openai/gpt-5.1" } }),
    })

    await Effect.runPromise(
      Effect.all(
        [registry.clearAll(a).pipe(Effect.asVoid), registry.set(a, "plan", ref("openai/o4"))],
        { concurrency: "unbounded" },
      ),
    )

    const onDisk = persistedOverrides(files)
    expect(await listed(registry, a)).toEqual(onDisk)
    // Whichever order they ran in, the cleared agents never come back.
    expect(onDisk.build).toBeUndefined()
    expect(onDisk.explore).toBeUndefined()
  })
})
