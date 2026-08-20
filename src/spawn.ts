import type { Session } from "@opencode-ai/schema/session"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Schema } from "effect"
import type { LookupError } from "./domain.ts"

/**
 * The spawn tools and the input field naming the agent to run.
 *
 * `subagent` is the public tool; `task`/`subagent_type` is the shape some
 * internal builds use. `execute.before` runs before the tool's own input
 * validation, so both are matched defensively and anything unexpected is left
 * alone rather than rejected.
 */
const AGENT_FIELD: ReadonlyMap<string, string> = new Map([
  ["subagent", "agent"],
  ["task", "subagent_type"],
])

export interface Request {
  /** The input field that names the agent, `agent` or `subagent_type`. */
  readonly field: string
  readonly agent: string
  readonly input: Readonly<Record<string, unknown>>
}

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

/** The agent a raw, not yet validated tool input asks to spawn. */
export const request = (tool: string, input: unknown): Request | undefined => {
  const field = AGENT_FIELD.get(tool)
  if (field === undefined) return undefined
  if (Array.isArray(input)) return undefined

  const decoded = decodeRecord(input)
  if (decoded._tag === "None") return undefined

  const named = decoded.value[field]
  if (typeof named !== "string") return undefined
  const agent = named.trim()
  if (agent === "") return undefined

  return { field, agent, input: decoded.value }
}

/** The same input with the named agent replaced, as a fresh object. */
export const redirect = (spawn: Request, target: string): Record<string, unknown> => ({
  ...spawn.input,
  [spawn.field]: target,
})

/**
 * The part of an `execute.before` event this hook reads and rewrites.
 *
 * `sessionID` is the session whose turn is making the tool call, which for a
 * spawn is the parent of the child session about to be created. That is the
 * session whose overrides apply: a nested spawn made from a subagent's own
 * session is that session's spawn, not the top-level one's.
 */
export interface Event {
  readonly tool: string
  readonly sessionID: Session.ID
  input: unknown
}

export interface Router {
  /** The overrides one session set, including dormant ones. */
  readonly overrides: (
    sessionID: Session.ID,
  ) => Effect.Effect<ReadonlyArray<{ readonly agent: string }>>
  /** The materialized variant for a session's override, or `undefined` when there is none. */
  readonly variantFor: (sessionID: Session.ID, agent: string) => string | undefined
  /**
   * Re-snapshots the agents as OpenCode resolves them now and re-materializes
   * the variants from that snapshot.
   */
  readonly synchronize: Effect.Effect<void, LookupError>
}

/**
 * Points a native spawn of an agent the calling session overrode at that
 * session's hidden variant of it.
 *
 * This runs before the spawn tool validates its input and before OpenCode
 * resolves the agent, so replacing the id here keeps the whole native path: a
 * real child session, nested as usual, on the variant's model.
 *
 * The variant is a copy of the source agent, so it is refreshed from the
 * current one before every redirected spawn rather than only when it is
 * missing: an edited prompt, a revoked permission or a changed request setting
 * must not survive in the copy. After a restart nothing is materialized yet,
 * and this same step is what puts the variants in place.
 */
export const route =
  (router: Router) =>
  (event: Event): Effect.Effect<void, Tool.Error> =>
    Effect.gen(function* () {
      const spawn = request(event.tool, event.input)
      if (spawn === undefined) return
      // Only what this session set: another session's override of the same
      // agent must leave this spawn exactly as it was.
      const overrides = yield* router.overrides(event.sessionID)
      if (!overrides.some((override) => override.agent === spawn.agent)) return

      // A failure here leaves the input alone: a spawn on the source agent's own
      // model is a better outcome than one on a variant nobody refreshed. The
      // step itself covers every session, because the variants share one agent
      // registry.
      yield* router.synchronize

      const target = router.variantFor(event.sessionID, spawn.agent)
      // Nothing to redirect to: the override is dormant because no agent of that
      // name is defined here, or no legal id was free. Let the spawn proceed.
      if (target === undefined) return

      event.input = redirect(spawn, target)
      // A hook can only fail with a `Tool.Error`, so a failed read of the
      // running server surfaces as one rather than as a defect.
    }).pipe(Effect.mapError((error) => new Tool.Error({ message: error.display })))
