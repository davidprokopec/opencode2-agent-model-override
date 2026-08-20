import type { Model } from "@opencode-ai/schema/model"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Option, Semaphore } from "effect"
import * as ModelRef from "./model.ts"
import * as Store from "./store.ts"

export interface Override {
  readonly agent: string
  readonly model: Model.Ref
}

/** An override together with the session it belongs to. */
export interface SessionOverride extends Override {
  readonly sessionID: Session.ID
}

export interface Interface {
  /**
   * The overrides one session set, including ones for agents that do not exist
   * here.
   *
   * Read from disk on every call, so a change another registry over the same
   * document made is observed rather than shadowed by a stale copy. Another
   * session's overrides are never returned: an override is in effect only for
   * the session that set it.
   */
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Override>>
  /**
   * Every session's overrides.
   *
   * Only for materializing the hidden variants, which live in the one agent
   * registry this process has and therefore have to cover every session at once.
   */
  readonly listAll: Effect.Effect<ReadonlyArray<SessionOverride>>
  readonly set: (
    sessionID: Session.ID,
    agent: string,
    model: Model.Ref,
  ) => Effect.Effect<void, Store.StoreError>
  readonly clear: (
    sessionID: Session.ID,
    agent: string,
  ) => Effect.Effect<Option.Option<Override>, Store.StoreError>
  readonly clearAll: (
    sessionID: Session.ID,
  ) => Effect.Effect<ReadonlyArray<Override>, Store.StoreError>
}

type Overrides = ReadonlyMap<string, Model.Ref>
type Sessions = ReadonlyMap<Session.ID, Overrides>

const toOverrides = (state: Overrides): ReadonlyArray<Override> =>
  [...state]
    .map(([agent, model]) => ({ agent, model }))
    .sort((a, b) => a.agent.localeCompare(b.agent))

const forSession = (state: Sessions, sessionID: Session.ID): Overrides =>
  state.get(sessionID) ?? new Map()

/** The document with one session's overrides replaced, or dropped when empty. */
const replace = (state: Sessions, sessionID: Session.ID, overrides: Overrides): Sessions => {
  const next = new Map(state)
  // An emptied session would otherwise stay in the document forever as a key
  // with nothing under it.
  if (overrides.size === 0) next.delete(sessionID)
  else next.set(sessionID, overrides)
  return next
}

const encode = (state: Sessions): Store.State => ({
  version: 2,
  sessions: Object.fromEntries(
    [...state].map(([sessionID, overrides]) => [
      sessionID,
      Object.fromEntries([...overrides].map(([agent, model]) => [agent, ModelRef.format(model)])),
    ]),
  ),
})

const decode = (state: Store.State): Effect.Effect<Sessions> =>
  Effect.gen(function* () {
    const decoded = new Map<Session.ID, Overrides>()
    for (const [sessionID, overrides] of Object.entries(state.sessions)) {
      const session = new Map<string, Model.Ref>()
      for (const [agent, model] of Object.entries(overrides)) {
        const parsed = yield* ModelRef.parse(model).pipe(
          Effect.asSome,
          Effect.orElseSucceed(Option.none),
        )
        if (Option.isNone(parsed)) {
          yield* Effect.logWarning(
            `opencode2-agent-model-override: ignoring override for ${agent} in session ${sessionID}, ${JSON.stringify(model)} is not a model reference`,
          )
          continue
        }
        session.set(agent, parsed.value)
      }
      decoded.set(Session.ID.make(sessionID), session)
    }
    return decoded
  })

/**
 * One mutation lock per state document, shared by every registry in this process.
 *
 * OpenCode instantiates a plugin once per location, so several registries back
 * the same file inside one service. A lock held by an individual registry would
 * only serialize that registry's own callers, and two locations reading,
 * changing and writing the document at once would lose one of the two changes.
 * Keying on the path is what makes them take turns.
 *
 * Independent OS processes are still not coordinated; that is documented.
 */
const locks = new Map<string, Semaphore.Semaphore>()

const lockFor = (path: string): Semaphore.Semaphore => {
  const existing = locks.get(path)
  if (existing !== undefined) return existing
  // Created synchronously, so two registries constructed concurrently cannot
  // interleave between the lookup and the insert and end up with a lock each.
  const created = Semaphore.makeUnsafe(1)
  locks.set(path, created)
  return created
}

/**
 * The persisted overrides, read from the document on every use.
 *
 * Nothing is cached: a registry that trusted its own copy would keep serving
 * overrides another registry over the same file had already changed. Mutations
 * hold the document's lock across a fresh read, the change and the write, so
 * concurrent changes compose instead of overwriting one another.
 */
export const make = (store: Store.Interface): Effect.Effect<Interface> =>
  Effect.sync(() => {
    const mutation = lockFor(store.path)

    /** The document as it is right now; an unreadable one reads as empty. */
    const current: Effect.Effect<Sessions> = store.read.pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `opencode2-agent-model-override: ${error.display}; continuing with no overrides`,
        ).pipe(Effect.as(Store.empty)),
      ),
      Effect.flatMap(decode),
    )

    /**
     * Re-reads the document under the lock, applies `change` and writes back
     * the map it returns; `undefined` means there is nothing to write.
     *
     * The write is uninterruptible, and deliberately so even though the lock
     * already serializes callers: interrupting a fiber parked on the write
     * would release its permit while the underlying filesystem call is still in
     * flight, because a promise cannot be cancelled. The next mutation would
     * then acquire the permit and write, and the abandoned write would land
     * afterwards and overwrite it. Holding off interruption until the write has
     * settled keeps the permit and the disk in step.
     */
    const modify = <A>(
      change: (state: Sessions) => readonly [Sessions | undefined, A],
    ): Effect.Effect<A, Store.StoreError> =>
      mutation.withPermit(
        Effect.gen(function* () {
          const [next, result] = change(yield* current)
          if (next !== undefined) yield* Effect.uninterruptible(store.write(encode(next)))
          return result
        }),
      )

    return {
      list: (sessionID) =>
        current.pipe(Effect.map((state) => toOverrides(forSession(state, sessionID)))),

      listAll: current.pipe(
        Effect.map((state) =>
          [...state]
            .flatMap(([sessionID, overrides]) =>
              toOverrides(overrides).map((override) => ({ sessionID, ...override })),
            )
            .sort(
              (a, b) => a.sessionID.localeCompare(b.sessionID) || a.agent.localeCompare(b.agent),
            ),
        ),
      ),

      set: (sessionID, agent, model) =>
        modify((state) => [
          replace(state, sessionID, new Map(forSession(state, sessionID)).set(agent, model)),
          undefined,
        ]).pipe(Effect.asVoid),

      clear: (sessionID, agent) =>
        modify((state) => {
          const overrides = forSession(state, sessionID)
          const model = overrides.get(agent)
          if (model === undefined) return [undefined, Option.none<Override>()]
          const next = new Map(overrides)
          next.delete(agent)
          return [replace(state, sessionID, next), Option.some({ agent, model })]
        }),

      clearAll: (sessionID) =>
        modify((state) => {
          const cleared = toOverrides(forSession(state, sessionID))
          return cleared.length === 0
            ? [undefined, cleared]
            : [replace(state, sessionID, new Map()), cleared]
        }),
    }
  })
