import type { Session } from "@opencode-ai/schema/session"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, Option, Schema } from "effect"
import type { AgentSummary, CatalogModel, LookupError } from "./domain.ts"
import * as ModelRef from "./model.ts"
import type * as Registry from "./registry.ts"

export interface Environment {
  readonly registry: Registry.Interface
  readonly agents: Effect.Effect<ReadonlyArray<AgentSummary>, LookupError>
  readonly models: Effect.Effect<ReadonlyArray<CatalogModel>, LookupError>
  /**
   * Re-snapshots the source agents, re-reads every session's overrides and
   * reloads, so the hidden variants match the state that was just written.
   */
  readonly synchronize: Effect.Effect<void, LookupError>
  /** The materialized variant id for a session's override, when there is one. */
  readonly variantFor: (sessionID: Session.ID, base: string) => string | undefined
}

const failWith = (message: string) => Effect.fail(new Tool.Error({ message }))

const asToolError = <A, E extends { readonly display: string }>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, Tool.Error> =>
  effect.pipe(Effect.mapError((error) => new Tool.Error({ message: error.display })))

/** Subagents first: they are what a spawn actually uses. */
const knownAgents = (agents: ReadonlyArray<AgentSummary>): string => {
  const subagents = agents.filter((agent) => agent.mode === "subagent").map((agent) => agent.id)
  const others = agents.filter((agent) => agent.mode !== "subagent").map((agent) => agent.id)
  const parts: Array<string> = []
  if (subagents.length > 0) parts.push(`subagents: ${subagents.join(", ")}`)
  if (others.length > 0) parts.push(`other agents: ${others.join(", ")}`)
  return parts.length === 0 ? "no agents are defined here" : parts.join("; ")
}

const pending = (overrides: ReadonlyArray<Registry.Override>): string =>
  overrides.map((override) => `${override.agent} → ${ModelRef.format(override.model)}`).join(", ")

const setTool = (env: Environment) =>
  ({
    name: "agent_model_override_set",
    description:
      "Redirect one agent to a different model for the current session, for example when its " +
      "configured provider is out of quota. Affects only spawns made from this session; other " +
      "sessions are unaffected. Persisted for this session, so it survives restarts. The " +
      "agent's own definition is left untouched; spawns are routed to a hidden copy of it that " +
      "differs only in the model.",
    input: Schema.Struct({
      agent: Schema.String.annotate({
        description: 'Id of the agent to redirect, e.g. "build" or "explore".',
      }),
      model: Schema.String.annotate({
        description:
          'Replacement model as "provider/model", e.g. "anthropic/claude-sonnet-4-5", ' +
          'optionally "provider/model#variant".',
      }),
    }),
    options: { codemode: false },
    execute: Effect.fn("agent_model_override_set")(function* (input, context) {
      const agentID = input.agent.trim()
      if (agentID === "") return yield* failWith("Which agent should be redirected? Pass its id.")

      const ref = yield* asToolError(ModelRef.parse(input.model))
      const agents = yield* asToolError(env.agents)

      const agent = agents.find((candidate) => candidate.id === agentID)
      if (agent === undefined) {
        return yield* failWith(
          `No agent ${JSON.stringify(agentID)} is defined here (${knownAgents(agents)}).`,
        )
      }

      const models = yield* asToolError(env.models)
      const model = ModelRef.find(models, ref)
      if (model === undefined) {
        return yield* failWith(
          `No model ${JSON.stringify(ModelRef.format(ref))} is available. Check the model list; ` +
            "the provider may not be configured.",
        )
      }
      if (ref.variant !== undefined && !ModelRef.hasVariant(model, ref.variant)) {
        const variants = model.variants.map((variant) => variant.id)
        return yield* failWith(
          `Model ${model.providerID}/${model.id} has no variant ${JSON.stringify(ref.variant)}` +
            `${variants.length === 0 ? " and no variants at all" : `. Variants: ${variants.join(", ")}`}.`,
        )
      }

      // Stored against the catalog entry's own ids rather than what the caller
      // typed, which may have been the provider's `modelID` alias.
      const target = ModelRef.canonical(model, ref.variant)

      yield* asToolError(env.registry.set(context.sessionID, agentID, target))
      yield* asToolError(env.synchronize)

      const previous = agent.model === undefined ? undefined : ModelRef.format(agent.model)
      const variant = env.variantFor(context.sessionID, agentID)
      return {
        content:
          `Agent ${agentID} now uses ${ModelRef.format(target)}` +
          `${previous === undefined ? " (it had no model of its own)" : ` (was ${previous})`}` +
          " in this session. Every future spawn of this agent from this session, including a " +
          "normal subagent spawn, is routed to a hidden copy of it" +
          `${variant === undefined ? "" : ` (${variant})`} that has the new model and everything ` +
          "else identical; the agent's own definition is unchanged, other sessions still spawn " +
          "it on its configured model, and work already running keeps the model it started " +
          "with. The override is persisted for this session, so it survives restarts until " +
          "agent_model_override_clear.",
      }
    }),
  }) satisfies Tool.Info

const listTool = (env: Environment) =>
  ({
    name: "agent_model_override_list",
    description:
      "List the agent model overrides agent_model_override_set made in the current session. " +
      "Overrides other sessions set are not shown, because they do not apply here.",
    // Declared as raw JSON Schema rather than `Schema.Struct({})`, which
    // generates `anyOf: [object, array]` with no top-level `type`. Anthropic
    // rejects every request in the session when a tool schema omits `type`.
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: Effect.fn("agent_model_override_list")(function* (_input, context) {
      const overrides = yield* env.registry.list(context.sessionID)
      if (overrides.length === 0) {
        return { content: "No agent model overrides are set in this session." }
      }

      // Availability is a nicety, so a server that cannot answer degrades to
      // listing the overrides without it rather than failing the call.
      const agents = yield* env.agents.pipe(Effect.orElseSucceed(() => undefined))
      const models = yield* env.models.pipe(Effect.orElseSucceed(() => undefined))

      const lines = overrides.map((override) => {
        const notes: Array<string> = []
        if (agents !== undefined && !agents.some((agent) => agent.id === override.agent)) {
          notes.push("agent not defined here, override is dormant")
        }
        if (models !== undefined && ModelRef.find(models, override.model) === undefined) {
          notes.push("model not in the catalog")
        }
        const variant = env.variantFor(context.sessionID, override.agent)
        if (variant !== undefined) notes.push(`spawns routed to ${variant}`)
        return (
          `${override.agent} → ${ModelRef.format(override.model)}` +
          `${notes.length === 0 ? "" : `  (${notes.join("; ")})`}`
        )
      })

      return {
        content: [
          `${overrides.length} agent model override(s) in this session:`,
          ...lines,
          "They apply to spawns from this session only and are persisted for it.",
        ].join("\n"),
      }
    }),
  }) satisfies Tool.Info

const clearTool = (env: Environment) =>
  ({
    name: "agent_model_override_clear",
    description:
      "Remove one agent model override the current session set, or every one of them, so spawns " +
      "from this session go back to the agent itself and the model its configuration defines. " +
      "Overrides other sessions set are left alone.",
    input: Schema.Struct({
      agent: Schema.optional(
        Schema.String.annotate({ description: 'Id of the overridden agent, e.g. "build".' }),
      ),
      all: Schema.optional(
        Schema.Boolean.annotate({
          description: "Remove every agent model override of the current session.",
        }),
      ),
    }),
    options: { codemode: false },
    execute: Effect.fn("agent_model_override_clear")(function* (input, context) {
      // `Schema.optional` renders as `anyOf: [string, null]`, so a provider may
      // legitimately send null rather than omitting the field.
      const agentID = typeof input.agent === "string" ? input.agent.trim() : ""

      if (input.all === true) {
        const cleared = yield* asToolError(env.registry.clearAll(context.sessionID))
        if (cleared.length === 0) {
          return { content: "No agent model overrides to clear in this session." }
        }
        yield* asToolError(env.synchronize)
        return {
          content:
            `Cleared ${cleared.length} override(s) of this session: ${pending(cleared)}. ` +
            "The hidden copies are gone and spawns from this session go straight to those " +
            "agents again, on the model their configuration defines.",
        }
      }

      if (agentID === "") {
        const overrides = yield* env.registry.list(context.sessionID)
        return yield* failWith(
          overrides.length === 0
            ? "No agent model overrides are set in this session."
            : `Say which agent to clear, or pass all: true. Overridden: ${pending(overrides)}`,
        )
      }

      const cleared = yield* asToolError(env.registry.clear(context.sessionID, agentID))
      if (Option.isNone(cleared)) {
        const overrides = yield* env.registry.list(context.sessionID)
        return yield* failWith(
          `No model override for ${JSON.stringify(agentID)} in this session.${
            overrides.length === 0 ? "" : ` Overridden: ${pending(overrides)}`
          }`,
        )
      }

      yield* asToolError(env.synchronize)
      return {
        content:
          `Cleared this session's override for ${cleared.value.agent} ` +
          `(was ${ModelRef.format(cleared.value.model)}). ` +
          "Its hidden copy is gone and spawns from this session go straight to the agent again, " +
          "on the model from its configuration.",
      }
    }),
  }) satisfies Tool.Info

export const all = (env: Environment): ReadonlyArray<Tool.Info> => [
  setTool(env),
  listTool(env),
  clearTool(env),
]
