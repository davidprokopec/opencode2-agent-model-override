import type { AgentDraft } from "@opencode-ai/plugin/effect/agent"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Session } from "@opencode-ai/schema/session"
import { Effect, type Types } from "effect"
import * as ModelRef from "../src/model.ts"
import type * as Variant from "../src/variant.ts"

/**
 * A session id the test chooses.
 *
 * Fixed rather than generated, because a variant id is derived from the session
 * that set the override, so a test that asserts one needs a stable id.
 */
export const session = (id: string): Session.ID => Session.ID.make(id)

export type MutableAgent = Types.DeepMutable<Agent.Info>

/**
 * A realistic agent record: every field the plugin must carry over to a variant
 * is populated, so a test can prove the copy is complete and the source intact.
 */
export const makeAgent = (
  id: string,
  options: { readonly model?: string; readonly hidden?: boolean } = {},
): MutableAgent => ({
  id: Agent.ID.make(id),
  name: Agent.Name.make(id),
  ...(options.model === undefined ? {} : { model: Model.Ref.parse(options.model) }),
  request: { settings: { temperature: 0.2 }, headers: { "x-test": id }, body: { top_p: 0.9 } },
  system: `You are ${id}. Follow the repository conventions.`,
  description: `The ${id} agent`,
  mode: "subagent",
  hidden: options.hidden ?? false,
  color: "blue",
  steps: 12,
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "write", resource: "/etc/*", effect: "deny" },
  ],
})

/**
 * `Variant.synchronize` input for a server where `sources` is what
 * `ctx.agent.list()` returned.
 *
 * That is also where the plugin takes the occupied ids from, so they are
 * derived here the same way. `occupying` adds ids that are resolved without
 * being offered as sources, which is what a generated id has to avoid too.
 */
export const snapshot = (
  sources: ReadonlyArray<MutableAgent>,
  overrides: ReadonlyArray<Variant.Redirect>,
  occupying: ReadonlyArray<string> = [],
) => ({
  sources,
  overrides,
  occupied: [...sources.map((agent) => String(agent.id)), ...occupying],
})

/**
 * A fake `AgentDraft` over a map, recording the mutating calls.
 *
 * `update` for an id the draft does not have creates it from
 * `Agent.Info.default` and then runs the callback, which is exactly how the
 * real draft materializes a new agent.
 */
export const makeDraft = (agents: ReadonlyArray<MutableAgent>) => {
  const map = new Map(agents.map((agent) => [String(agent.id), agent]))
  const calls = {
    update: [] as Array<string>,
    created: [] as Array<string>,
    remove: [] as Array<string>,
    default: [] as Array<string | undefined>,
  }

  const draft: AgentDraft = {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    default: (id) => {
      calls.default.push(id)
    },
    update: (id, update) => {
      calls.update.push(id)
      let agent = map.get(id)
      if (agent === undefined) {
        calls.created.push(id)
        agent = Agent.Info.default(Agent.ID.make(id))
        map.set(id, agent)
      }
      update(agent)
    },
    remove: (id) => {
      calls.remove.push(id)
      map.delete(id)
    },
  }

  return { draft, map, calls }
}

/**
 * An agent's model as its canonical string.
 *
 * `Agent.Info["model"]` fields are branded, which no object literal satisfies,
 * so tests compare the formatted reference instead.
 */
export const modelOf = (agent: MutableAgent | undefined): string | undefined =>
  agent?.model === undefined ? undefined : ModelRef.format(agent.model)

export const ref = (input: string): Model.Ref => Effect.runSync(ModelRef.parse(input))
