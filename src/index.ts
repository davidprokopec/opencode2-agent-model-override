import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect, Semaphore } from "effect"
import { LookupError, reasonOf } from "./domain.ts"
import * as Node from "./node.ts"
import * as Registry from "./registry.ts"
import * as Spawn from "./spawn.ts"
import * as Store from "./store.ts"
import * as Tools from "./tools.ts"
import * as Variant from "./variant.ts"

export default Plugin.define({
  id: "opencode2-agent-model-override",
  effect: (ctx) =>
    Effect.gen(function* () {
      const store = Store.make(Node.fileSystem, Store.file())
      const registry = yield* Registry.make(store)
      const variants = Variant.make()

      const listed = ctx.agent.list().pipe(
        Effect.map((response) => response.data),
        Effect.mapError(
          (cause) => new LookupError({ resource: "agents", reason: reasonOf(cause) }),
        ),
      )

      /**
       * Re-reads every session's overrides, re-snapshots the agents as OpenCode
       * currently resolves them, and reloads so the transform below materializes
       * the variants.
       *
       * Every session at once for this OpenCode location: a session's spawn is
       * routed to its own variant, but all of them have to be materialized
       * together in the location-scoped agent registry.
       *
       * Serialized, so one caller's snapshot cannot land between another's
       * snapshot and reload.
       */
      const gate = yield* Semaphore.make(1)
      const synchronize = gate.withPermit(
        Effect.gen(function* () {
          const sources = yield* listed
          const overrides = yield* registry.listAll
          // Everything OpenCode resolves right now, which is what a generated
          // variant id must not land on.
          const occupied = sources.map((agent) => agent.id)
          variants.synchronize({ sources, overrides, occupied })
          yield* ctx.agent.reload()
        }),
      )

      /**
       * The only agent state this plugin writes.
       *
       * It adds hidden agents and never touches an existing one, so it does not
       * matter that OpenCode's own config transform runs at an order a plugin
       * cannot control: that transform re-applies the configured agents, which
       * this one no longer competes for.
       */
      yield* ctx.agent.transform((draft) => {
        variants.apply(draft)
      })

      const environment: Tools.Environment = {
        registry,
        synchronize,
        variantFor: variants.variantFor,
        // The variants are an implementation detail: they must not be offered
        // as agents to override, nor counted when reporting a dormant override.
        agents: listed.pipe(
          Effect.map((agents) => agents.filter((agent) => !variants.isVariant(agent.id))),
        ),
        models: ctx.catalog.model.list().pipe(
          Effect.map((response) => response.data),
          Effect.mapError(
            (cause) => new LookupError({ resource: "the model catalog", reason: reasonOf(cause) }),
          ),
        ),
      }

      yield* ctx.tool.transform((tools) => {
        for (const tool of Tools.all(environment)) tools.add(tool)
      })

      yield* ctx.tool.hook(
        "execute.before",
        Spawn.route({ overrides: registry.list, variantFor: variants.variantFor, synchronize }),
      )
    }),
})

export { Registry, Spawn, Store, Tools, Variant }
