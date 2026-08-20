import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode-ai/schema/tool"
import { Cause, Effect, Exit } from "effect"
import { LookupError } from "../src/domain.ts"
import * as Spawn from "../src/spawn.ts"
import * as Variant from "../src/variant.ts"
import { type MutableAgent, makeAgent, makeDraft, ref, session, snapshot } from "./support.ts"

/** The session making the spawns, and another one whose overrides must not reach it. */
const a = session("ses_a")
const b = session("ses_b")

describe("Spawn.request", () => {
  test("reads the agent from the public subagent tool", () => {
    const spawn = Spawn.request("subagent", { agent: "explore", prompt: "look around" })
    expect(spawn?.agent).toBe("explore")
    expect(spawn?.field).toBe("agent")
  })

  test("reads subagent_type from the task tool", () => {
    const spawn = Spawn.request("task", { subagent_type: "explore", description: "look" })
    expect(spawn?.agent).toBe("explore")
    expect(spawn?.field).toBe("subagent_type")
  })

  test("trims the named agent", () => {
    expect(Spawn.request("subagent", { agent: "  explore  " })?.agent).toBe("explore")
  })

  test("ignores every other tool", () => {
    for (const tool of ["bash", "read", "agent_model_override_set", ""]) {
      expect(Spawn.request(tool, { agent: "explore" })).toBeUndefined()
    }
  })

  test("ignores a field that belongs to the other shape", () => {
    expect(Spawn.request("subagent", { subagent_type: "explore" })).toBeUndefined()
    expect(Spawn.request("task", { agent: "explore" })).toBeUndefined()
  })

  test("ignores malformed input rather than rejecting the call", () => {
    // `execute.before` runs before the tool validates its own input, so
    // anything at all can arrive here.
    for (const input of [
      undefined,
      null,
      "explore",
      42,
      true,
      ["explore"],
      {},
      { agent: undefined },
      { agent: null },
      { agent: 7 },
      { agent: { id: "explore" } },
      { agent: ["explore"] },
      { agent: "" },
      { agent: "   " },
    ]) {
      expect(Spawn.request("subagent", input)).toBeUndefined()
    }
  })
})

describe("Spawn.redirect", () => {
  test("replaces only the agent field and keeps the rest of the input", () => {
    const input = { agent: "explore", prompt: "look around", depth: 2 }
    const spawn = Spawn.request("subagent", input)
    expect(spawn).toBeDefined()
    if (spawn === undefined) return

    const redirected = Spawn.redirect(spawn, "explore-mo-abc12345")

    expect(redirected).toEqual({ agent: "explore-mo-abc12345", prompt: "look around", depth: 2 })
    // A fresh object: the tool's own input must not be mutated underneath it.
    expect(redirected).not.toBe(input)
    expect(input.agent).toBe("explore")
  })

  test("replaces subagent_type for the task shape", () => {
    const spawn = Spawn.request("task", { subagent_type: "explore", description: "look" })
    expect(spawn).toBeDefined()
    if (spawn === undefined) return

    expect(Spawn.redirect(spawn, "explore-mo-abc12345")).toEqual({
      subagent_type: "explore-mo-abc12345",
      description: "look",
    })
  })

  test("keeps every unrelated field, of any shape, for both spawn tools", () => {
    const shared = {
      prompt: "investigate",
      depth: 3,
      nested: { retries: 2, tags: ["a", "b"] },
      flag: false,
      missing: null,
    }

    const subagentInput = { agent: "explore", ...shared }
    const subagentSpawn = Spawn.request("subagent", subagentInput)
    expect(subagentSpawn).toBeDefined()
    if (subagentSpawn === undefined) return
    const subagentRedirected = Spawn.redirect(subagentSpawn, "explore-mo-abc12345")
    expect(subagentRedirected).toEqual({ agent: "explore-mo-abc12345", ...shared })
    expect(subagentRedirected).not.toBe(subagentInput)
    expect(subagentInput.agent).toBe("explore")

    const taskInput = { subagent_type: "explore", ...shared }
    const taskSpawn = Spawn.request("task", taskInput)
    expect(taskSpawn).toBeDefined()
    if (taskSpawn === undefined) return
    const taskRedirected = Spawn.redirect(taskSpawn, "explore-mo-abc12345")
    expect(taskRedirected).toEqual({ subagent_type: "explore-mo-abc12345", ...shared })
    expect(taskRedirected).not.toBe(taskInput)
    expect(taskInput.subagent_type).toBe("explore")
  })
})

/**
 * The hook wired to a real variant manager, as the plugin does.
 *
 * `synchronize` stands in for the plugin's snapshot-and-reload: it is what
 * materializes the variants, so a test can count how often the hook needed it.
 */
const makeRouter = (
  options: {
    readonly overrides?: ReadonlyArray<readonly [string, string]>
    /** What a different session overrode, which must never affect a spawn from this one. */
    readonly elsewhere?: ReadonlyArray<readonly [string, string]>
    readonly sources?: ReadonlyArray<string>
    readonly fails?: boolean
  } = {},
) => {
  const overrides = [
    ...(options.overrides ?? [["explore", "openai/gpt-5.1"]]).map(([agent, model]) => ({
      sessionID: a,
      agent,
      model: ref(model),
    })),
    ...(options.elsewhere ?? []).map(([agent, model]) => ({
      sessionID: b,
      agent,
      model: ref(model),
    })),
  ]
  // Replaceable, because `ctx.agent.list()` answers with the agents as they are
  // resolved at the moment it is called, not with the records of an earlier one.
  let sources = (options.sources ?? ["explore", "build"]).map((id) => makeAgent(id))
  const variants = Variant.make()
  let synchronizations = 0

  const router: Spawn.Router = {
    overrides: (sessionID) =>
      Effect.sync(() => overrides.filter((override) => override.sessionID === sessionID)),
    variantFor: variants.variantFor,
    synchronize: Effect.gen(function* () {
      synchronizations += 1
      if (options.fails === true) {
        return yield* Effect.fail(new LookupError({ resource: "agents", reason: "gone" }))
      }
      variants.synchronize(snapshot(sources, overrides))
    }),
  }

  return {
    route: Spawn.route(router),
    variants,
    count: () => synchronizations,
    redefine: (next: ReadonlyArray<MutableAgent>) => {
      sources = [...next]
    },
  }
}

const run = async (
  route: (event: Spawn.Event) => Effect.Effect<void, Tool.Error>,
  tool: string,
  input: unknown,
  sessionID = a,
): Promise<unknown> => {
  const event: Spawn.Event = { tool, sessionID, input }
  await Effect.runPromise(route(event))
  return event.input
}

describe("Spawn.route", () => {
  test("rewrites the agent of a native subagent spawn to the variant", async () => {
    const { route, count } = makeRouter()

    const input = await run(route, "subagent", { agent: "explore", prompt: "look around" })

    expect(input).toEqual({ agent: Variant.variantId(a, "explore"), prompt: "look around" })
    // A persisted override is materialized by the first spawn that needs it.
    expect(count()).toBe(1)
  })

  test("rewrites subagent_type for the task shape", async () => {
    const { route } = makeRouter()

    const input = await run(route, "task", { subagent_type: "explore", description: "look" })

    expect(input).toEqual({
      subagent_type: Variant.variantId(a, "explore"),
      description: "look",
    })
  })

  test("re-snapshots before every redirected spawn, not only the first", async () => {
    const { route, count } = makeRouter()

    await run(route, "subagent", { agent: "explore" })
    await run(route, "subagent", { agent: "explore" })
    await run(route, "subagent", { agent: "explore" })

    expect(count()).toBe(3)
  })

  test("a spawn after the agent changed copies the definition it has now", async () => {
    const { route, variants, redefine } = makeRouter()

    await run(route, "subagent", { agent: "explore" })

    // The prompt is edited and a permission revoked between the two spawns.
    const edited = makeAgent("explore")
    edited.system = "You are explore. Read only."
    edited.permissions = [{ action: "write", resource: "*", effect: "deny" }]
    redefine([edited, makeAgent("build")])

    const input = await run(route, "subagent", { agent: "explore" })
    expect(input).toEqual({ agent: Variant.variantId(a, "explore") })

    const { draft, map } = makeDraft([edited])
    variants.apply(draft)
    const variant = map.get(Variant.variantId(a, "explore"))
    expect(variant?.system).toBe("You are explore. Read only.")
    expect(variant?.permissions).toEqual([{ action: "write", resource: "*", effect: "deny" }])
  })

  test("refreshes an edited request configuration before the next redirected spawn", async () => {
    const { route, variants, redefine } = makeRouter()

    await run(route, "subagent", { agent: "explore" })

    // The request settings, not just the prompt or permissions, are edited
    // between the two spawns.
    const edited = makeAgent("explore")
    edited.request = { settings: { temperature: 0.9 }, headers: { "x-test": "changed" }, body: {} }
    redefine([edited, makeAgent("build")])

    await run(route, "subagent", { agent: "explore" })

    const { draft, map } = makeDraft([edited])
    variants.apply(draft)
    const variant = map.get(Variant.variantId(a, "explore"))
    expect(variant?.request).toEqual(edited.request)
  })

  test("leaves a spawn from a session that set no override untouched", async () => {
    const { route, count } = makeRouter()

    const input = await run(route, "subagent", { agent: "explore", prompt: "go" }, b)

    expect(input).toEqual({ agent: "explore", prompt: "go" })
    // Nothing was overridden here, so there was nothing to materialize either.
    expect(count()).toBe(0)
  })

  test("routes each session's spawn of one agent to that session's own variant", async () => {
    const { route } = makeRouter({ elsewhere: [["explore", "anthropic/claude-4-5"]] })

    expect(await run(route, "subagent", { agent: "explore" }, a)).toEqual({
      agent: Variant.variantId(a, "explore"),
    })
    expect(await run(route, "subagent", { agent: "explore" }, b)).toEqual({
      agent: Variant.variantId(b, "explore"),
    })
  })

  test("leaves a spawn of an agent with no override untouched", async () => {
    const { route, count } = makeRouter()

    const input = await run(route, "subagent", { agent: "build", prompt: "go" })

    expect(input).toEqual({ agent: "build", prompt: "go" })
    expect(count()).toBe(0)
  })

  test("leaves a dormant override alone, because there is no agent to copy", async () => {
    const { route } = makeRouter({
      overrides: [["ghost", "openai/gpt-5.1"]],
      sources: ["explore"],
    })

    const input = await run(route, "subagent", { agent: "ghost" })

    expect(input).toEqual({ agent: "ghost" })
  })

  test("leaves every other tool untouched", async () => {
    const { route, count } = makeRouter()

    expect(await run(route, "bash", { agent: "explore" })).toEqual({ agent: "explore" })
    expect(await run(route, "read", { agent: "explore" })).toEqual({ agent: "explore" })
    expect(count()).toBe(0)
  })

  test("leaves malformed input untouched", async () => {
    const { route, count } = makeRouter()

    for (const input of [undefined, null, "explore", 42, ["explore"], {}, { agent: 7 }]) {
      expect(await run(route, "subagent", input)).toEqual(input)
    }
    expect(count()).toBe(0)
  })

  test("a server that cannot be read fails the hook as a Tool.Error", async () => {
    const { route } = makeRouter({ fails: true })
    const event: Spawn.Event = { tool: "subagent", sessionID: a, input: { agent: "explore" } }

    const exit = await Effect.runPromiseExit(route(event))

    expect(Exit.isFailure(exit)).toBe(true)
    // The rewrite happens only after a snapshot that succeeded.
    expect(event.input).toEqual({ agent: "explore" })
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(Tool.Error)
    if (!(error instanceof Tool.Error)) return
    expect(error.message).toContain("agents")
  })

  test("a failed synchronize leaves the original input object itself untouched", async () => {
    const { route } = makeRouter({ fails: true })
    const input = { agent: "explore", prompt: "look around" }
    const event: Spawn.Event = { tool: "subagent", sessionID: a, input }

    await Effect.runPromiseExit(route(event))

    // Not just an equal copy: the very object the caller handed in, since a
    // hook that fails must not have touched it at all.
    expect(event.input).toBe(input)
  })

  test(
    "routes off event.sessionID even when the real hook's other fields (agent, messageID, " +
      "id) happen to read like a different session's id",
    async () => {
      // The real `ToolHooks["execute.before"]` event this hook is registered
      // against also carries `agent` (the id of the agent whose turn is
      // calling the spawn tool, e.g. "build") plus `messageID` and `id`, none
      // of which this module's own `Event` type declares. Passed through a
      // variable rather than a literal typed as `Spawn.Event`, so these extra
      // fields survive to reach `route` exactly as they would from the real
      // hook, instead of being rejected by an excess-property check.
      const event = {
        tool: "subagent",
        sessionID: a,
        // Deliberately the other session's own id, in fields `route` must not
        // read: if it keyed off any of these instead of `sessionID`, session
        // a's spawn would be routed using session b's overrides (here, none).
        agent: b,
        messageID: b,
        id: b,
        input: { agent: "explore", prompt: "go" } as unknown,
      }

      const { route } = makeRouter({ elsewhere: [["explore", "anthropic/claude-4-5"]] })

      await Effect.runPromise(route(event))

      // Session a's own override applies (the default "explore" override the
      // router seeds), not session b's ("elsewhere"), regardless of what
      // agent/messageID/id say.
      expect(event.input).toEqual({ agent: Variant.variantId(a, "explore"), prompt: "go" })
    },
  )
})
