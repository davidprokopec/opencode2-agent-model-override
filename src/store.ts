import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { Effect, Schema } from "effect"
import { reasonOf } from "./domain.ts"

/**
 * On-disk form of every override, as a single versioned document.
 *
 * Overrides are grouped by the session that set them, because an override is
 * only ever in effect for that one session. Values are the canonical
 * `provider/model[#variant]` strings rather than a decomposed reference, so a
 * file written by one version stays readable by a future one that parses
 * references differently. Change this shape only in a backwards compatible way,
 * or bump `version` and migrate.
 */
export const State = Schema.Struct({
  version: Schema.Literal(2),
  sessions: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
})
export type State = typeof State.Type

export const empty: State = { version: 2, sessions: {} }

/**
 * Version 1: one flat override map for the whole installation.
 *
 * Those entries belonged to no session, so there is no session they could be
 * migrated into without silently handing one session another's overrides. A v1
 * document therefore reads as no overrides at all, and the next write replaces
 * it with a v2 one.
 */
const Legacy = Schema.Struct({
  version: Schema.Literal(1),
  overrides: Schema.Record(Schema.String, Schema.String),
})

const decodeState = Schema.decodeUnknownOption(State)
const decodeLegacy = Schema.decodeUnknownOption(Legacy)

export class StoreError extends Schema.TaggedError<StoreError>()(
  "opencode2-agent-model-override/StoreError",
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.String,
  },
) {
  get display(): string {
    return `${this.operation} failed for ${this.path}: ${this.reason}`
  }
}

export const directory = (env: NodeJS.ProcessEnv = process.env): string => {
  const base = env.XDG_STATE_HOME?.trim()
  const root = base !== undefined && base !== "" ? base : join(homedir(), ".local", "state")
  return join(root, "opencode2-agent-model-override")
}

export const file = (env: NodeJS.ProcessEnv = process.env): string =>
  join(directory(env), "overrides.json")

/** Parent of a host-native path, plus Windows paths used by cross-platform callers/tests. */
export const parentDirectory = (path: string): string =>
  win32.isAbsolute(path) ? win32.dirname(path) : dirname(path)

/** Injected so the store can be tested without touching a real disk. */
export interface FileSystem {
  readonly mkdir: (path: string) => Promise<void>
  /** `undefined` when the file does not exist, which is not an error here. */
  readonly readFile: (path: string) => Promise<string | undefined>
  /** Must replace the file atomically: a reader never sees a partial document. */
  readonly writeAtomic: (path: string, contents: string) => Promise<void>
}

export interface Interface {
  /** The document this store reads and writes, which identifies the state it owns. */
  readonly path: string
  /**
   * Missing file and version 1 document both read as empty; malformed content
   * fails, for the caller to report.
   */
  readonly read: Effect.Effect<State, StoreError>
  readonly write: (state: State) => Effect.Effect<void, StoreError>
}

const fail = (operation: string, path: string) => (cause: unknown) =>
  new StoreError({ operation, path, reason: reasonOf(cause) })

export const make = (fs: FileSystem, path: string): Interface => ({
  path,

  read: Effect.gen(function* () {
    const contents = yield* Effect.tryPromise({
      try: () => fs.readFile(path),
      catch: fail("readFile", path),
    })
    if (contents === undefined) return empty

    const parsed = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: fail("parse", path),
    })
    const decoded = decodeState(parsed)
    if (decoded._tag === "Some") return decoded.value
    if (decodeLegacy(parsed)._tag === "Some") return empty

    return yield* Effect.fail(
      new StoreError({ operation: "decode", path, reason: "unrecognised file contents" }),
    )
  }),

  write: (state) =>
    Effect.gen(function* () {
      const parent = parentDirectory(path)
      yield* Effect.tryPromise({ try: () => fs.mkdir(parent), catch: fail("mkdir", parent) })
      yield* Effect.tryPromise({
        try: () => fs.writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`),
        catch: fail("writeAtomic", path),
      })
    }),
})
