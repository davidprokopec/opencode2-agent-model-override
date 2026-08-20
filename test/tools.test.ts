import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode-ai/schema/agent"
import type { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Tool } from "@opencode-ai/schema/tool"
import { Cause, Effect, Exit } from "effect"
import { type AgentSummary, type CatalogModel, LookupError } from "../src/domain.ts"
import * as ModelRef from "../src/model.ts"
import * as Registry from "../src/registry.ts"
import * as Store from "../src/store.ts"
import * as Tools from "../src/tools.ts"
import * as Variant from "../src/variant.ts"
import { makeAgent, session, snapshot } from "./support.ts"

/** A document of its own per environment, so no two tests share disk state. */
let sequence = 0
const nextPath = (): string => {
  sequence += 1
  return `/data/tools-${sequence}/overrides.json`
}

/** The summaries the tools see, as the fully resolved agents the manager takes. */
const sourceAgents = (summaries: ReadonlyArray<AgentSummary>) =>
  summaries.map((summary) => makeAgent(summary.id))

const agents: ReadonlyArray<AgentSummary> = [
  { id: "build", name: "build", mode: "primary" },
  { id: "explore", name: "explore", mode: "subagent" },
  { id: "review", name: "review", mode: "subagent" },
]

const models: ReadonlyArray<CatalogModel> = [
  {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
    modelID: "claude-sonnet-4-5",
    variants: [{ id: "thinking" }],
  },
  { providerID: "openai", id: "gpt-5.1", modelID: "gpt-5.1", variants: [] },
  {
    providerID: "github-copilot",
    id: "claude-sonnet-4.5",
    modelID: "claude-sonnet-4.5-copilot",
    variants: [],
  },
]

/** The session the tools are called from, and another one they must not reach into. */
const a = session("ses_a")
const b = session("ses_b")

/** A `Tool.Context` built from the real brand constructors, so no cast is needed. */
const contextFor = (sessionID: Session.ID): Tool.Context => ({
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.create(),
  id: Tool.CallID.make("call_test"),
  progress: () => Effect.void,
})

const makeEnvironment = async (
  options: {
    /** What the calling session has overridden already. */
    readonly seed?: Record<string, string>
    /** What a different session has overridden, which must never leak into this one. */
    readonly seedElsewhere?: Record<string, string>
    readonly agents?: ReadonlyArray<AgentSummary>
    readonly models?: ReadonlyArray<CatalogModel>
    readonly agentsFail?: boolean
    readonly modelsFail?: boolean
    readonly synchronizeFails?: boolean
  } = {},
) => {
  const path = nextPath()
  const sessions = {
    ...(options.seed === undefined ? {} : { [a]: options.seed }),
    ...(options.seedElsewhere === undefined ? {} : { [b]: options.seedElsewhere }),
  }
  const files = new Map<string, string>(
    Object.keys(sessions).length === 0
      ? []
      : [[path, `${JSON.stringify({ version: 2, sessions }, null, 2)}\n`]],
  )
  const fs: Store.FileSystem = {
    mkdir: async () => {},
    readFile: async (target) => files.get(target),
    writeAtomic: async (target, contents) => {
      files.set(target, contents)
    },
  }
  const registry = await Effect.runPromise(Registry.make(Store.make(fs, path)))
  const variants = Variant.make()
  let reloads = 0

  /** What the plugin does for real: re-snapshot, re-read, materialize. */
  const synchronize = Effect.gen(function* () {
    reloads += 1
    if (options.synchronizeFails === true) {
      return yield* Effect.fail(new LookupError({ resource: "agents", reason: "gone" }))
    }
    const overrides = yield* registry.listAll
    variants.synchronize(snapshot(sourceAgents(options.agents ?? agents), overrides))
  })

  const env: Tools.Environment = {
    registry,
    synchronize,
    variantFor: variants.variantFor,
    agents:
      options.agentsFail === true
        ? Effect.fail(new LookupError({ resource: "agents", reason: "connection refused" }))
        : Effect.succeed(options.agents ?? agents),
    models:
      options.modelsFail === true
        ? Effect.fail(new LookupError({ resource: "the model catalog", reason: "timeout" }))
        : Effect.succeed(options.models ?? models),
  }

  return { env, registry, variants, files, reloadCount: () => reloads }
}

const tool = (env: Tools.Environment, name: string): Tool.Info => {
  const found = Tools.all(env).find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no such tool: ${name}`)
  return found
}

/** Every tool here resolves `content` to a plain string. */
const contentText = (result: Tool.Result): string => {
  if (typeof result.content !== "string") {
    throw new Error(`expected string content, got ${JSON.stringify(result.content)}`)
  }
  return result.content
}

const succeed = async (
  env: Tools.Environment,
  name: string,
  input: unknown,
  sessionID: Session.ID = a,
): Promise<string> => {
  const result = await Effect.runPromise(tool(env, name).execute(input, contextFor(sessionID)))
  return contentText(result)
}

/**
 * The message of the `Tool.Error` a call failed with.
 *
 * Runs the executor exactly once, so a test can also assert that the failed
 * call had no side effects.
 */
const failure = async (
  env: Tools.Environment,
  name: string,
  input: unknown,
  sessionID: Session.ID = a,
): Promise<string> => {
  const exit = await Effect.runPromiseExit(tool(env, name).execute(input, contextFor(sessionID)))
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`)
  }
  if (Cause.hasDies(exit.cause)) {
    throw new Error(`expected a typed Tool.Error, got a defect: ${Cause.pretty(exit.cause)}`)
  }
  const error = Cause.squash(exit.cause)
  if (!(error instanceof Tool.Error)) {
    throw new Error(`expected a Tool.Error, got ${JSON.stringify(error)}`)
  }
  return error.message
}

/** The document that environment's filesystem holds, once something wrote it. */
const overridesOnDisk = (files: Map<string, string>): string | undefined => [...files.values()][0]

describe("tool registration", () => {
  test("exposes the three direct tools with codemode disabled", async () => {
    const { env } = await makeEnvironment()
    const all = Tools.all(env)

    expect(all.map((candidate) => candidate.name)).toEqual([
      "agent_model_override_set",
      "agent_model_override_list",
      "agent_model_override_clear",
    ])
    for (const candidate of all) {
      expect(candidate.options?.codemode).toBe(false)
      expect(candidate.description.length).toBeGreaterThan(0)
    }
  })

  test("the no-input tool declares an object schema with an explicit type", async () => {
    const { env } = await makeEnvironment()
    // Anthropic rejects a session outright when a tool schema has no top level
    // `type`, which `Schema.Struct({})` would produce.
    expect(tool(env, "agent_model_override_list").input).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })
})

describe("agent_model_override_set", () => {
  test("persists the override and reports that future spawns are affected", async () => {
    const { env, registry, files, reloadCount } = await makeEnvironment()

    const content = await succeed(env, "agent_model_override_set", {
      agent: "explore",
      model: "anthropic/claude-sonnet-4-5",
    })

    expect(content).toContain("explore")
    expect(content).toContain("anthropic/claude-sonnet-4-5")
    expect(content).toContain("future spawn")
    expect(overridesOnDisk(files)).toContain("anthropic/claude-sonnet-4-5")
    expect(reloadCount()).toBe(1)

    const listed = await Effect.runPromise(registry.list(a))
    expect(listed.map((override) => override.agent)).toEqual(["explore"])
  })

  test("materializes the hidden variant and reports that spawns go through it", async () => {
    const { env, variants } = await makeEnvironment()

    const content = await succeed(env, "agent_model_override_set", {
      agent: "explore",
      model: "anthropic/claude-sonnet-4-5",
    })

    const variant = Variant.variantId(a, "explore")
    expect(variants.variantFor(a, "explore")).toBe(variant)
    expect(content).toContain(variant)
    expect(content).toContain("hidden copy")
    expect(content).toContain("definition is unchanged")
  })

  test("a synchronize that cannot read the server is reported, after persisting", async () => {
    const { env, registry, files } = await makeEnvironment({ synchronizeFails: true })

    const message = await failure(env, "agent_model_override_set", {
      agent: "explore",
      model: "openai/gpt-5.1",
    })

    expect(message).toContain("agents")
    // The override reached the disk before the reload was attempted, so the
    // next spawn or tool call still picks it up.
    expect(overridesOnDisk(files)).toContain("openai/gpt-5.1")
    expect((await Effect.runPromise(registry.list(a))).length).toBe(1)
  })

  test("trims whitespace around both arguments", async () => {
    const { env, registry } = await makeEnvironment()

    await succeed(env, "agent_model_override_set", {
      agent: "  explore  ",
      model: "  openai/gpt-5.1  ",
    })

    const listed = await Effect.runPromise(registry.list(a))
    expect(
      listed.map((override) => `${override.agent}=${ModelRef.format(override.model)}`),
    ).toEqual(["explore=openai/gpt-5.1"])
  })

  test("accepts a variant the catalog declares", async () => {
    const { env, registry } = await makeEnvironment()

    await succeed(env, "agent_model_override_set", {
      agent: "explore",
      model: "anthropic/claude-sonnet-4-5#thinking",
    })

    const listed = await Effect.runPromise(registry.list(a))
    const first = listed[0]
    expect(first === undefined ? undefined : ModelRef.format(first.model)).toBe(
      "anthropic/claude-sonnet-4-5#thinking",
    )
  })

  test("stores the catalog id when the caller uses a modelID alias", async () => {
    const { env, registry, files } = await makeEnvironment()

    await succeed(env, "agent_model_override_set", {
      agent: "explore",
      model: "github-copilot/claude-sonnet-4.5-copilot",
    })

    const listed = await Effect.runPromise(registry.list(a))
    expect(listed.map((override) => ModelRef.format(override.model))).toEqual([
      "github-copilot/claude-sonnet-4.5",
    ])
    expect(overridesOnDisk(files)).toContain("github-copilot/claude-sonnet-4.5")
    expect(overridesOnDisk(files)).not.toContain("claude-sonnet-4.5-copilot")
  })

  test("rejects an unknown agent and lists the ones that exist", async () => {
    const { env, files, reloadCount } = await makeEnvironment()

    const message = await failure(env, "agent_model_override_set", {
      agent: "nope",
      model: "openai/gpt-5.1",
    })

    expect(message).toContain("nope")
    expect(message).toContain("explore")
    expect(message).toContain("review")
    expect(message).toContain("build")
    expect(overridesOnDisk(files)).toBeUndefined()
    expect(reloadCount()).toBe(0)
  })

  test("rejects a blank agent", async () => {
    const { env } = await makeEnvironment()
    const message = await failure(env, "agent_model_override_set", {
      agent: "   ",
      model: "openai/gpt-5.1",
    })
    expect(message).toContain("Which agent")
  })

  for (const model of ["", "gpt-5.1", "/gpt-5.1", "openai/"]) {
    test(`rejects ${JSON.stringify(model)} as a model reference`, async () => {
      const { env } = await makeEnvironment()
      const message = await failure(env, "agent_model_override_set", { agent: "explore", model })
      expect(message).toContain("provider/model")
    })
  }

  test("rejects a model the catalog does not have", async () => {
    const { env, files } = await makeEnvironment()

    const message = await failure(env, "agent_model_override_set", {
      agent: "explore",
      model: "openai/gpt-9",
    })

    expect(message).toContain("openai/gpt-9")
    expect(overridesOnDisk(files)).toBeUndefined()
  })

  test("rejects a variant the model does not declare and names the real ones", async () => {
    const { env } = await makeEnvironment()

    const message = await failure(env, "agent_model_override_set", {
      agent: "explore",
      model: "anthropic/claude-sonnet-4-5#turbo",
    })

    expect(message).toContain("turbo")
    expect(message).toContain("thinking")
  })

  test("rejects a variant on a model with no variants at all", async () => {
    const { env } = await makeEnvironment()
    const message = await failure(env, "agent_model_override_set", {
      agent: "explore",
      model: "openai/gpt-5.1#thinking",
    })
    expect(message).toContain("no variants")
  })

  test("reports an unreadable agent list instead of writing blindly", async () => {
    const { env, files } = await makeEnvironment({ agentsFail: true })

    const message = await failure(env, "agent_model_override_set", {
      agent: "explore",
      model: "openai/gpt-5.1",
    })

    expect(message).toContain("agents")
    expect(overridesOnDisk(files)).toBeUndefined()
  })

  test("replacing an existing override keeps a single entry", async () => {
    const { env, registry } = await makeEnvironment({ seed: { explore: "openai/gpt-5.1" } })

    const content = await succeed(env, "agent_model_override_set", {
      agent: "explore",
      model: "anthropic/claude-sonnet-4-5",
    })

    expect(content).toContain("anthropic/claude-sonnet-4-5")
    expect((await Effect.runPromise(registry.list(a))).length).toBe(1)
  })
})

describe("agent_model_override_list", () => {
  test("says so when nothing is overridden", async () => {
    const { env } = await makeEnvironment()
    expect(await succeed(env, "agent_model_override_list", {})).toContain("No agent model override")
  })

  test("lists every override with its target model", async () => {
    const { env } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1", review: "anthropic/claude-sonnet-4-5#thinking" },
    })

    const content = await succeed(env, "agent_model_override_list", {})

    expect(content).toContain("explore")
    expect(content).toContain("openai/gpt-5.1")
    expect(content).toContain("review")
    expect(content).toContain("anthropic/claude-sonnet-4-5#thinking")
  })

  test("names the hidden agent a materialized override routes spawns to", async () => {
    const { env } = await makeEnvironment()
    await succeed(env, "agent_model_override_set", { agent: "explore", model: "openai/gpt-5.1" })

    const content = await succeed(env, "agent_model_override_list", {})

    expect(content).toContain(Variant.variantId(a, "explore"))
    expect(content).toContain("routed to")
  })

  test("flags a dormant override for an agent that is not defined here", async () => {
    const { env } = await makeEnvironment({ seed: { ghost: "openai/gpt-5.1" } })
    const content = await succeed(env, "agent_model_override_list", {})
    expect(content).toContain("ghost")
    expect(content).toContain("dormant")
  })

  test("flags a target model that is no longer in the catalog", async () => {
    const { env } = await makeEnvironment({ seed: { explore: "openai/retired-model" } })
    const content = await succeed(env, "agent_model_override_list", {})
    expect(content).toContain("not in the catalog")
  })

  test("still lists overrides when the server cannot be read", async () => {
    const { env } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1" },
      agentsFail: true,
      modelsFail: true,
    })

    const content = await succeed(env, "agent_model_override_list", {})

    expect(content).toContain("explore")
    expect(content).toContain("openai/gpt-5.1")
    expect(content).not.toContain("dormant")
  })
})

describe("agent_model_override_clear", () => {
  test("clears one agent, persists and reloads", async () => {
    const { env, registry, files, reloadCount } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1", review: "openai/gpt-5.1" },
    })

    const content = await succeed(env, "agent_model_override_clear", { agent: "explore" })

    expect(content).toContain("explore")
    expect(content).toContain("openai/gpt-5.1")
    expect(reloadCount()).toBe(1)
    expect((await Effect.runPromise(registry.list(a))).map((o) => o.agent)).toEqual(["review"])
    expect(overridesOnDisk(files)).not.toContain("explore")
  })

  test("clearing takes the hidden variant away with the override", async () => {
    const { env, variants } = await makeEnvironment()
    await succeed(env, "agent_model_override_set", { agent: "explore", model: "openai/gpt-5.1" })
    expect(variants.variantFor(a, "explore")).toBeDefined()

    const content = await succeed(env, "agent_model_override_clear", { agent: "explore" })

    expect(variants.variantFor(a, "explore")).toBeUndefined()
    expect(content).toContain("hidden copy is gone")
  })

  test("clears everything with all", async () => {
    const { env, registry, reloadCount } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1", review: "anthropic/claude-sonnet-4-5" },
    })

    const content = await succeed(env, "agent_model_override_clear", { all: true })

    expect(content).toContain("explore")
    expect(content).toContain("review")
    expect(await Effect.runPromise(registry.list(a))).toEqual([])
    expect(reloadCount()).toBe(1)
  })

  test("all with nothing set neither fails nor reloads", async () => {
    const { env, reloadCount } = await makeEnvironment()
    const content = await succeed(env, "agent_model_override_clear", { all: true })
    expect(content).toContain("No agent model overrides to clear")
    expect(reloadCount()).toBe(0)
  })

  test("empty input explains which overrides are active", async () => {
    const { env, reloadCount } = await makeEnvironment({ seed: { explore: "openai/gpt-5.1" } })

    const message = await failure(env, "agent_model_override_clear", {})

    expect(message).toContain("explore")
    expect(message).toContain("openai/gpt-5.1")
    expect(message).toContain("all")
    expect(reloadCount()).toBe(0)
  })

  test("empty input with nothing set says there is nothing to clear", async () => {
    const { env } = await makeEnvironment()
    const message = await failure(env, "agent_model_override_clear", {})
    expect(message).toContain("No agent model overrides are set")
  })

  test("a null agent from a provider behaves like an omitted one", async () => {
    const { env } = await makeEnvironment({ seed: { explore: "openai/gpt-5.1" } })
    const message = await failure(env, "agent_model_override_clear", { agent: null })
    expect(message).toContain("explore")
  })

  test("clearing an agent with no override lists what is overridden", async () => {
    const { env, registry, reloadCount } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1" },
    })

    const message = await failure(env, "agent_model_override_clear", { agent: "review" })

    expect(message).toContain("review")
    expect(message).toContain("explore")
    expect((await Effect.runPromise(registry.list(a))).length).toBe(1)
    expect(reloadCount()).toBe(0)
  })

  test("clears a dormant override for an agent that does not exist here", async () => {
    const { env, registry } = await makeEnvironment({ seed: { ghost: "openai/gpt-5.1" } })

    const content = await succeed(env, "agent_model_override_clear", { agent: "ghost" })

    expect(content).toContain("ghost")
    expect(await Effect.runPromise(registry.list(a))).toEqual([])
  })
})

describe("session scope", () => {
  test("list shows the calling session's overrides and no other session's", async () => {
    const { env } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1" },
      seedElsewhere: { review: "anthropic/claude-sonnet-4-5" },
    })

    const here = await succeed(env, "agent_model_override_list", {})
    expect(here).toContain("explore")
    expect(here).not.toContain("review")

    const there = await succeed(env, "agent_model_override_list", {}, b)
    expect(there).toContain("review")
    expect(there).not.toContain("explore")
  })

  test("an override set in one session is not listed in another", async () => {
    const { env, registry } = await makeEnvironment()

    await succeed(env, "agent_model_override_set", { agent: "explore", model: "openai/gpt-5.1" })

    expect(await succeed(env, "agent_model_override_list", {}, b)).toContain(
      "No agent model overrides are set in this session",
    )
    expect(await Effect.runPromise(registry.list(b))).toEqual([])
  })

  test("each session's override materializes a hidden copy of its own", async () => {
    const { env, registry, variants } = await makeEnvironment()

    await succeed(env, "agent_model_override_set", { agent: "explore", model: "openai/gpt-5.1" })
    await succeed(
      env,
      "agent_model_override_set",
      { agent: "explore", model: "anthropic/claude-sonnet-4-5" },
      b,
    )

    expect(variants.variantFor(a, "explore")).toBe(Variant.variantId(a, "explore"))
    expect(variants.variantFor(b, "explore")).toBe(Variant.variantId(b, "explore"))
    expect(
      (await Effect.runPromise(registry.listAll)).map(
        (override) => `${override.sessionID}/${ModelRef.format(override.model)}`,
      ),
    ).toEqual(["ses_a/openai/gpt-5.1", "ses_b/anthropic/claude-sonnet-4-5"])
  })

  test("clearing another session's override is refused, and that session keeps it", async () => {
    const { env, registry } = await makeEnvironment({
      seedElsewhere: { explore: "openai/gpt-5.1" },
    })

    const message = await failure(env, "agent_model_override_clear", { agent: "explore" })

    expect(message).toContain('No model override for "explore" in this session')
    expect((await Effect.runPromise(registry.list(b))).map((o) => o.agent)).toEqual(["explore"])
  })

  test("clearing everything empties the calling session only", async () => {
    const { env, registry } = await makeEnvironment({
      seed: { explore: "openai/gpt-5.1" },
      seedElsewhere: { review: "anthropic/claude-sonnet-4-5" },
    })

    const content = await succeed(env, "agent_model_override_clear", { all: true })

    expect(content).toContain("explore")
    expect(await Effect.runPromise(registry.list(a))).toEqual([])
    expect((await Effect.runPromise(registry.list(b))).map((o) => o.agent)).toEqual(["review"])
  })

  test(
    "scoping follows context.sessionID even when context.agent and context.messageID are " +
      "spoofed to look like the other session's identifier",
    async () => {
      const { env, registry } = await makeEnvironment()

      // `Tool.Context` also carries `agent` (the id of the agent whose turn is
      // calling this tool, e.g. "build") and `messageID`. Both are unrelated to
      // session scope, but a wrong-field read (`context.agent` or
      // `context.messageID` instead of `context.sessionID`) would silently
      // pass every test elsewhere in this file, because those tests hold
      // `agent` fixed at `"build"` and let `messageID` vary randomly for every
      // session equally. Here each session's own id is planted in the *other*
      // fields, so a wrong-field read produces an observably wrong session.
      const contextOne: Tool.Context = {
        sessionID: a,
        agent: Agent.ID.make("ses_b"),
        messageID: SessionMessage.ID.make("msg_ses_b"),
        id: Tool.CallID.make("ses_b"),
        progress: () => Effect.void,
      }
      const contextTwo: Tool.Context = {
        sessionID: b,
        agent: Agent.ID.make("ses_a"),
        messageID: SessionMessage.ID.make("msg_ses_a"),
        id: Tool.CallID.make("ses_a"),
        progress: () => Effect.void,
      }

      await Effect.runPromise(
        tool(env, "agent_model_override_set").execute(
          { agent: "explore", model: "openai/gpt-5.1" },
          contextOne,
        ),
      )
      await Effect.runPromise(
        tool(env, "agent_model_override_set").execute(
          { agent: "review", model: "anthropic/claude-sonnet-4-5" },
          contextTwo,
        ),
      )

      expect((await Effect.runPromise(registry.list(a))).map((o) => o.agent)).toEqual(["explore"])
      expect((await Effect.runPromise(registry.list(b))).map((o) => o.agent)).toEqual(["review"])

      const listOne = await Effect.runPromise(
        tool(env, "agent_model_override_list").execute({}, contextOne),
      )
      const listTwo = await Effect.runPromise(
        tool(env, "agent_model_override_list").execute({}, contextTwo),
      )
      expect(contentText(listOne)).toContain("explore")
      expect(contentText(listOne)).not.toContain("review")
      expect(contentText(listTwo)).toContain("review")
      expect(contentText(listTwo)).not.toContain("explore")
    },
  )
})

describe("set then list then clear", () => {
  test("round trips through the tool surface", async () => {
    const { env, files } = await makeEnvironment()

    await succeed(env, "agent_model_override_set", {
      agent: "review",
      model: "anthropic/claude-sonnet-4-5#thinking",
    })
    expect(await succeed(env, "agent_model_override_list", {})).toContain(
      "anthropic/claude-sonnet-4-5#thinking",
    )

    await succeed(env, "agent_model_override_clear", { agent: "review" })
    expect(await succeed(env, "agent_model_override_list", {})).toContain("No agent model override")
    // The session is dropped from the document once it holds nothing.
    expect(overridesOnDisk(files)).toContain('"sessions": {}')
  })
})
