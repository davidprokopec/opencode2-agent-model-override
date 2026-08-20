import { describe, expect, test } from "bun:test"
import * as Variant from "../src/variant.ts"
import {
  type MutableAgent,
  makeAgent,
  makeDraft,
  modelOf,
  ref,
  session,
  snapshot,
} from "./support.ts"

const LEGAL = /^[a-z0-9-]+$/

/** The session most of these tests speak for, and a second one to be isolated from. */
const a = session("ses_a")
const b = session("ses_b")

const redirect = (agent: string, model: string, sessionID = a) => ({
  sessionID,
  agent,
  model: ref(model),
})

describe("Variant.variantId", () => {
  test("is deterministic", () => {
    expect(Variant.variantId(a, "explore")).toBe(Variant.variantId(a, "explore"))
  })

  test("is legal and stays inside the 64 character budget", () => {
    for (const base of [
      "a",
      "explore",
      "Review-Agent",
      "my.agent_name",
      "  spaced  ",
      "ünïcødé",
      "x".repeat(200),
      "-".repeat(80),
    ]) {
      const id = Variant.variantId(a, base)
      expect(id).toMatch(LEGAL)
      expect(id.length).toBeLessThanOrEqual(64)
      expect(id.length).toBeGreaterThan(0)
    }
  })

  test("never equals the agent it is derived from", () => {
    for (const base of ["explore", "build", "explore-mo-00000000"]) {
      expect(Variant.variantId(a, base)).not.toBe(base)
    }
    // The one input that would otherwise collide with its own output.
    const self = Variant.variantId(a, "explore")
    expect(Variant.variantId(a, self)).not.toBe(self)
  })

  test("keeps the source id readable in the generated one", () => {
    expect(Variant.variantId(a, "explore").startsWith("explore-mo-")).toBe(true)
  })

  test("two sessions overriding one agent never derive the same id", () => {
    expect(Variant.variantId(a, "explore")).not.toBe(Variant.variantId(b, "explore"))
    // Not even across the salted candidates, so neither session can displace
    // the other's variant while the ids are being allocated.
    const candidates = (sessionID: typeof a) =>
      Array.from({ length: 17 }, (_, salt) => Variant.variantId(sessionID, "explore", salt))
    expect(new Set([...candidates(a), ...candidates(b)]).size).toBe(34)
  })

  test("stays legal and bounded however long the session id is", () => {
    const long = session(`ses_${"9".repeat(200)}`)
    for (const base of ["explore", "x".repeat(200), "!!!"]) {
      const id = Variant.variantId(long, base)
      expect(id).toMatch(LEGAL)
      expect(id.length).toBeLessThanOrEqual(64)
    }
  })

  test("distinguishes agents whose readable prefix is the same", () => {
    // Both slug to `my-agent`, so only the hash keeps them apart.
    expect(Variant.variantId(a, "my.agent")).not.toBe(Variant.variantId(a, "my-agent"))
    expect(Variant.variantId(a, "my.agent")).not.toBe(Variant.variantId(a, "my_agent"))
  })

  test("distinguishes agents that share the first fifty characters", () => {
    const long = "a".repeat(60)
    expect(Variant.variantId(a, `${long}-one`)).not.toBe(Variant.variantId(a, `${long}-two`))
  })

  test("gives a base with no usable characters a fallback prefix", () => {
    const id = Variant.variantId(a, "!!!")
    expect(id).toMatch(LEGAL)
    expect(id.startsWith("agent-mo-")).toBe(true)
  })

  test("every salted candidate is deterministic, distinct, legal and bounded", () => {
    for (const base of ["explore", "x".repeat(200), "ünïcødé", "!!!"]) {
      const candidates = Array.from({ length: 17 }, (_, salt) => Variant.variantId(a, base, salt))
      for (const [salt, candidate] of candidates.entries()) {
        expect(candidate).toBe(Variant.variantId(a, base, salt))
        expect(candidate).toMatch(LEGAL)
        expect(candidate.length).toBeLessThanOrEqual(64)
      }
      expect(new Set(candidates).size).toBe(candidates.length)
      expect(candidates[0]).toBe(Variant.variantId(a, base))
    }
  })
})

describe("Variant.apply", () => {
  const synchronized = (
    sources: ReadonlyArray<MutableAgent>,
    overrides: ReadonlyArray<{ readonly agent: string; readonly model: string }>,
  ) => {
    const manager = Variant.make()
    manager.synchronize(
      snapshot(
        sources,
        overrides.map((override) => redirect(override.agent, override.model)),
      ),
    )
    return manager
  }

  test("creates a hidden subagent variant and leaves the source untouched", () => {
    const explore = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = synchronized([explore], [{ agent: "explore", model: "anthropic/claude-4-5" }])
    const { draft, map, calls } = makeDraft([explore])
    const before = structuredClone(explore)

    manager.apply(draft)

    const id = Variant.variantId(a, "explore")
    const variant = map.get(id)
    expect(variant).toBeDefined()
    if (variant === undefined) return

    expect(String(variant.id)).toBe(id)
    expect(String(variant.name)).toBe(id)
    expect(variant.hidden).toBe(true)
    expect(variant.mode).toBe("subagent")
    expect(modelOf(variant)).toBe("anthropic/claude-4-5")

    // The source agent is never an argument to `update`, and is byte for byte
    // what it was: OpenCode's own config transform owns that record.
    expect(calls.update).toEqual([id])
    expect(calls.created).toEqual([id])
    expect(calls.remove).toEqual([])
    expect(calls.default).toEqual([])
    expect(map.get("explore")).toEqual(before)
    expect(modelOf(map.get("explore"))).toBe("openai/gpt-5.1")
  })

  test("copies every resolved field the source carries", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = synchronized([source], [{ agent: "explore", model: "openai/gpt-5.1-mini" }])
    const { draft, map } = makeDraft([source])

    manager.apply(draft)

    const variant = map.get(Variant.variantId(a, "explore"))
    expect(variant).toBeDefined()
    if (variant === undefined) return

    // Everything except the identity, model and visibility is the source's.
    const carried = (agent: MutableAgent) => {
      const { id: _id, name: _name, model: _model, hidden: _hidden, mode: _mode, ...rest } = agent
      return rest
    }
    expect(carried(variant)).toEqual(carried(source))
    expect(variant.system).toBe(source.system)
    expect(variant.description).toBe(source.description)
    expect(variant.steps).toBe(source.steps)
    expect(variant.color).toBe(source.color)
    expect(variant.request).toEqual(source.request)
    expect(variant.permissions).toEqual(source.permissions)
  })

  test("shares no nested reference with the source", () => {
    const source = makeAgent("explore")
    const manager = synchronized([source], [{ agent: "explore", model: "openai/gpt-5.1" }])
    const { draft, map } = makeDraft([source])

    manager.apply(draft)

    const variant = map.get(Variant.variantId(a, "explore"))
    expect(variant).toBeDefined()
    if (variant === undefined) return

    expect(variant.permissions).not.toBe(source.permissions)
    expect(variant.permissions[0]).not.toBe(source.permissions[0])
    expect(variant.request).not.toBe(source.request)
    expect(variant.request.settings).not.toBe(source.request.settings)

    // Mutating the copy must not reach back into the agent it was copied from.
    variant.permissions.push({ action: "write", resource: "*", effect: "deny" })
    variant.request.settings.temperature = 1
    expect(source.permissions.length).toBe(3)
    expect(source.request.settings.temperature).toBe(0.2)
  })

  test("creates nothing for an override whose agent is not defined here", () => {
    const manager = synchronized(
      [makeAgent("explore")],
      [{ agent: "ghost", model: "openai/gpt-5.1" }],
    )
    const { draft, map, calls } = makeDraft([makeAgent("explore")])

    manager.apply(draft)

    expect(calls.update).toEqual([])
    expect(map.size).toBe(1)
    expect(manager.variantFor(a, "ghost")).toBeUndefined()
    expect(manager.list()).toEqual([])
  })

  test("creates nothing when no override is set", () => {
    const manager = synchronized([makeAgent("explore")], [])
    const { draft, map, calls } = makeDraft([makeAgent("explore")])

    manager.apply(draft)

    expect(calls.update).toEqual([])
    expect(map.size).toBe(1)
  })

  test("is idempotent, because OpenCode replays transforms on every reload", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = synchronized([source], [{ agent: "explore", model: "openai/gpt-5.1-mini" }])
    const first = makeDraft([source])

    manager.apply(first.draft)
    const once = structuredClone(first.map.get(Variant.variantId(a, "explore")))

    const second = makeDraft([source])
    manager.apply(second.draft)

    expect(second.map.get(Variant.variantId(a, "explore"))).toEqual(once)
  })

  test("one variant per override, each from its own source", () => {
    const sources = [
      makeAgent("explore", { model: "openai/gpt-5.1" }),
      makeAgent("review", { model: "openai/gpt-5.1" }),
      makeAgent("build"),
    ]
    const manager = synchronized(sources, [
      { agent: "explore", model: "anthropic/claude-4-5" },
      { agent: "review", model: "openai/gpt-5.1-mini" },
    ])
    const { draft, map } = makeDraft(sources)

    manager.apply(draft)

    expect(map.size).toBe(5)
    expect(modelOf(map.get(Variant.variantId(a, "explore")))).toBe("anthropic/claude-4-5")
    expect(modelOf(map.get(Variant.variantId(a, "review")))).toBe("openai/gpt-5.1-mini")
    expect(map.get(Variant.variantId(a, "build"))).toBeUndefined()
    expect(map.get(Variant.variantId(a, "explore"))?.description).toBe("The explore agent")
    expect(map.get(Variant.variantId(a, "review"))?.description).toBe("The review agent")
  })

  test("a permission rule scoped to the source id does not name the variant", () => {
    // Known limitation: a parent's rules are matched against the id the child
    // session actually runs as, which is the generated one. A scoped rule has
    // to allow that id, or a pattern covering it.
    const id = Variant.variantId(a, "explore")
    expect(id).not.toBe("explore")
    expect(id.startsWith("explore-")).toBe(true)
  })
})

describe("Variant.synchronize", () => {
  test("replaces the snapshot and the overrides on every call", () => {
    const manager = Variant.make()
    const explore = makeAgent("explore")
    const review = makeAgent("review")

    manager.synchronize(snapshot([explore], [redirect("explore", "openai/gpt-5.1")]))
    expect(manager.variantFor(a, "explore")).toBe(Variant.variantId(a, "explore"))

    manager.synchronize(snapshot([review], [redirect("review", "openai/gpt-5.1")]))
    expect(manager.variantFor(a, "explore")).toBeUndefined()
    expect(manager.variantFor(a, "review")).toBe(Variant.variantId(a, "review"))
  })

  test("clearing every override materializes nothing while the sources remain", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = Variant.make()
    manager.synchronize(snapshot([source], [redirect("explore", "openai/mini")]))
    const first = makeDraft([source])
    manager.apply(first.draft)
    expect(first.map.size).toBe(2)

    manager.synchronize(snapshot([source], []))
    const second = makeDraft([source])
    manager.apply(second.draft)

    expect(manager.variantFor(a, "explore")).toBeUndefined()
    expect(second.map.size).toBe(1)
    expect(second.map.get("explore")).toEqual(source)
  })

  test("clearing an override leaves the base exactly as it was before it was ever overridden", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    // Taken before any synchronize/apply round, so this actually detects a
    // mutation rather than comparing the source object to itself.
    const pristine = structuredClone(source)
    const manager = Variant.make()

    manager.synchronize(snapshot([source], [redirect("explore", "openai/gpt-5.1-mini")]))
    const withVariant = makeDraft([source])
    manager.apply(withVariant.draft)
    const id = Variant.variantId(a, "explore")
    expect(withVariant.map.get(id)).toBeDefined()

    manager.synchronize(snapshot([source], []))
    const afterClear = makeDraft([source])
    manager.apply(afterClear.draft)

    expect(manager.variantFor(a, "explore")).toBeUndefined()
    expect(afterClear.map.has(id)).toBe(false)
    expect(source).toEqual(pristine)
    expect(afterClear.map.get("explore")).toEqual(pristine)
  })

  test("a later snapshot never treats a materialized variant as a source", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = Variant.make()
    manager.synchronize(snapshot([source], [redirect("explore", "openai/mini")]))
    const { draft, map } = makeDraft([source])
    manager.apply(draft)

    const id = Variant.variantId(a, "explore")
    const materialized = map.get(id)
    expect(materialized).toBeDefined()
    if (materialized === undefined) return

    // What `ctx.agent.list()` returns after the reload: sources plus variants.
    manager.synchronize(
      snapshot(
        [source, materialized],
        [redirect("explore", "openai/mini"), redirect(id, "openai/mini")],
      ),
    )

    expect(manager.isVariant(id)).toBe(true)
    expect(manager.variantFor(a, id)).toBeUndefined()
    expect(manager.list().map((variant) => variant.id)).toEqual([id])
  })

  test("a re-set override updates the same variant id rather than adding one", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = Variant.make()
    const id = Variant.variantId(a, "explore")

    manager.synchronize(snapshot([source], [redirect("explore", "openai/mini")]))
    const first = makeDraft([source])
    manager.apply(first.draft)
    const materialized = first.map.get(id)
    expect(materialized).toBeDefined()
    if (materialized === undefined) return

    manager.synchronize(
      snapshot([source, materialized], [redirect("explore", "anthropic/claude-4-5")]),
    )
    const second = makeDraft([source, materialized])
    manager.apply(second.draft)

    expect(second.map.size).toBe(2)
    expect(modelOf(second.map.get(id))).toBe("anthropic/claude-4-5")
  })

  test("an agent that only appears later gets its variant then", () => {
    const manager = Variant.make()
    manager.synchronize(snapshot([], [redirect("late", "openai/gpt-5.1")]))
    expect(manager.variantFor(a, "late")).toBeUndefined()

    const late = makeAgent("late")
    manager.synchronize(snapshot([late], [redirect("late", "openai/gpt-5.1")]))
    const { draft, map } = makeDraft([late])
    manager.apply(draft)

    expect(modelOf(map.get(Variant.variantId(a, "late")))).toBe("openai/gpt-5.1")
  })

  test("isVariant is false for anything this manager did not create", () => {
    const manager = Variant.make()
    expect(manager.isVariant("explore")).toBe(false)
    expect(manager.isVariant(Variant.variantId(a, "explore"))).toBe(false)
  })

  test("an agent already holding the deterministic id is neither used nor touched", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const impostor = makeAgent(Variant.variantId(a, "explore"), { model: "openai/gpt-5.1" })
    const untouched = { source: structuredClone(source), impostor: structuredClone(impostor) }
    const manager = Variant.make()

    manager.synchronize(snapshot([source, impostor], [redirect("explore", "anthropic/claude-4-5")]))

    const id = manager.variantFor(a, "explore")
    expect(id).toBe(Variant.variantId(a, "explore", 1))
    expect(id).not.toBe(Variant.variantId(a, "explore"))

    const { draft, map, calls } = makeDraft([source, impostor])
    manager.apply(draft)

    expect(calls.update).toEqual([Variant.variantId(a, "explore", 1)])
    expect(calls.remove).toEqual([])
    expect(map.get(Variant.variantId(a, "explore"))).toEqual(untouched.impostor)
    expect(map.get("explore")).toEqual(untouched.source)
    expect(modelOf(map.get(Variant.variantId(a, "explore", 1)))).toBe("anthropic/claude-4-5")
  })

  test("an occupied id that is not offered as a source still blocks", () => {
    const source = makeAgent("explore")
    const manager = Variant.make()

    // A hidden agent, say, that is resolved without being a candidate to copy.
    manager.synchronize(
      snapshot(
        [source],
        [redirect("explore", "openai/gpt-5.1")],
        [Variant.variantId(a, "explore")],
      ),
    )

    expect(manager.variantFor(a, "explore")).toBe(Variant.variantId(a, "explore", 1))
  })

  test("a configured hidden agent occupying a candidate id is never touched by apply", () => {
    const source = makeAgent("explore")
    // A real, hidden agent that is not offered as a source — the way a hidden
    // agent unrelated to this plugin can be resolved without ever being a
    // candidate to copy — yet it is still present in the draft OpenCode is
    // building, and its id is correctly reported as occupied.
    const impostor = makeAgent(Variant.variantId(a, "explore"), { hidden: true })
    const before = structuredClone(impostor)
    const manager = Variant.make()

    manager.synchronize(
      snapshot(
        [source],
        [redirect("explore", "anthropic/claude-4-5")],
        [Variant.variantId(a, "explore")],
      ),
    )
    expect(manager.variantFor(a, "explore")).toBe(Variant.variantId(a, "explore", 1))

    // The draft actually holds the impostor, unlike `sources`: this is what
    // `apply` sees when it decides what to write.
    const { draft, map, calls } = makeDraft([source, impostor])
    manager.apply(draft)

    expect(calls.update).toEqual([Variant.variantId(a, "explore", 1)])
    expect(map.get(Variant.variantId(a, "explore"))).toEqual(before)
  })

  test("the id survives repeated synchronization unchanged", () => {
    const source = makeAgent("explore")
    const impostor = makeAgent(Variant.variantId(a, "explore"))
    const manager = Variant.make()
    const chosen: Array<string | undefined> = []

    let listed: ReadonlyArray<MutableAgent> = [source, impostor]
    for (let round = 0; round < 3; round += 1) {
      manager.synchronize(snapshot(listed, [redirect("explore", "openai/gpt-5.1")]))
      const { draft, map } = makeDraft(listed)
      manager.apply(draft)
      chosen.push(manager.variantFor(a, "explore"))
      // What the next `ctx.agent.list()` returns: the sources plus the variant
      // the reload just materialized.
      listed = [...map.values()]
    }

    expect(chosen).toEqual([
      Variant.variantId(a, "explore", 1),
      Variant.variantId(a, "explore", 1),
      Variant.variantId(a, "explore", 1),
    ])
    expect(listed.length).toBe(3)
  })

  test("an id it no longer holds belongs to whoever is named that next", () => {
    const source = makeAgent("explore")
    const id = Variant.variantId(a, "explore")
    const manager = Variant.make()

    manager.synchronize(snapshot([source], [redirect("explore", "openai/gpt-5.1")]))
    manager.apply(makeDraft([source]).draft)
    expect(manager.variantFor(a, "explore")).toBe(id)

    // The override is cleared, so nothing of this manager's answers to that id.
    manager.synchronize(snapshot([source], []))
    expect(manager.isVariant(id)).toBe(false)

    // A configured agent of that name is then a real agent, not the old variant.
    const impostor = makeAgent(id)
    const untouched = structuredClone(impostor)
    manager.synchronize(snapshot([source, impostor], [redirect("explore", "openai/gpt-5.1")]))

    expect(manager.variantFor(a, "explore")).toBe(Variant.variantId(a, "explore", 1))
    const { draft, map } = makeDraft([source, impostor])
    manager.apply(draft)
    expect(map.get(id)).toEqual(untouched)
  })

  test("gives up on an override rather than overwrite, when every id is taken", () => {
    const source = makeAgent("explore")
    const manager = Variant.make()
    const candidates = Array.from({ length: 17 }, (_, salt) =>
      Variant.variantId(a, "explore", salt),
    )

    manager.synchronize(snapshot([source], [redirect("explore", "openai/gpt-5.1")], candidates))

    expect(manager.variantFor(a, "explore")).toBeUndefined()
    expect(manager.list()).toEqual([])

    const { draft, map, calls } = makeDraft([source])
    manager.apply(draft)
    expect(calls.update).toEqual([])
    expect(map.size).toBe(1)
  })

  test("two overrides never share an id, even when one is displaced", () => {
    const explore = makeAgent("explore")
    const review = makeAgent("review")
    const manager = Variant.make()

    manager.synchronize(
      snapshot(
        [explore, review],
        [redirect("explore", "openai/gpt-5.1"), redirect("review", "openai/gpt-5.1")],
        [Variant.variantId(a, "explore")],
      ),
    )

    const ids = manager.list().map((variant) => variant.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([Variant.variantId(a, "explore", 1), Variant.variantId(a, "review")])
  })

  test("list reports each override with its source, variant id and model", () => {
    const manager = Variant.make()
    manager.synchronize(
      snapshot(
        [makeAgent("explore")],
        [redirect("explore", "openai/gpt-5.1#high"), redirect("ghost", "openai/gpt-5.1")],
      ),
    )

    expect(
      manager.list().map((variant) => `${variant.base}=${variant.id}=${variant.model.id}`),
    ).toEqual([`explore=${Variant.variantId(a, "explore")}=gpt-5.1`])
  })

  test("list says which session each variant belongs to", () => {
    const manager = Variant.make()
    manager.synchronize(
      snapshot(
        [makeAgent("explore")],
        [redirect("explore", "openai/gpt-5.1"), redirect("explore", "openai/gpt-5.1-mini", b)],
      ),
    )

    expect(manager.list().map((variant) => `${variant.sessionID}/${variant.base}`)).toEqual([
      "ses_a/explore",
      "ses_b/explore",
    ])
  })
})

describe("Variant sessions", () => {
  test("two sessions overriding one agent to different models coexist", () => {
    const source = makeAgent("explore", { model: "openai/gpt-5.1" })
    const manager = Variant.make()

    manager.synchronize(
      snapshot(
        [source],
        [
          redirect("explore", "openai/gpt-5.1-mini"),
          redirect("explore", "anthropic/claude-4-5", b),
        ],
      ),
    )

    expect(manager.variantFor(a, "explore")).toBe(Variant.variantId(a, "explore"))
    expect(manager.variantFor(b, "explore")).toBe(Variant.variantId(b, "explore"))

    const { draft, map } = makeDraft([source])
    manager.apply(draft)

    // The source and one hidden copy per session, neither holding the other's model.
    expect(map.size).toBe(3)
    expect(modelOf(map.get(Variant.variantId(a, "explore")))).toBe("openai/gpt-5.1-mini")
    expect(modelOf(map.get(Variant.variantId(b, "explore")))).toBe("anthropic/claude-4-5")
    expect(modelOf(map.get("explore"))).toBe("openai/gpt-5.1")
  })

  test("a session with no override of its own is routed nowhere", () => {
    const manager = Variant.make()
    manager.synchronize(snapshot([makeAgent("explore")], [redirect("explore", "openai/gpt-5.1")]))

    expect(manager.variantFor(b, "explore")).toBeUndefined()
  })

  test("clearing one session's override leaves the other session's variant alone", () => {
    const source = makeAgent("explore")
    const manager = Variant.make()
    manager.synchronize(
      snapshot(
        [source],
        [redirect("explore", "openai/gpt-5.1"), redirect("explore", "anthropic/claude-4-5", b)],
      ),
    )

    // Only the second session's override remains in the registry.
    manager.synchronize(snapshot([source], [redirect("explore", "anthropic/claude-4-5", b)]))

    expect(manager.variantFor(a, "explore")).toBeUndefined()
    expect(manager.variantFor(b, "explore")).toBe(Variant.variantId(b, "explore"))

    const { draft, map } = makeDraft([source])
    manager.apply(draft)
    expect(map.has(Variant.variantId(a, "explore"))).toBe(false)
    expect(modelOf(map.get(Variant.variantId(b, "explore")))).toBe("anthropic/claude-4-5")
  })
})

/** Adversarial pairs that collide when variable strings are joined by a delimiter. */
describe("Variant adversarial session/agent separators", () => {
  test(
    "a colon inside an overridden agent's name can reproduce another pair's digest, " +
      "but the two overrides still resolve to distinct, correctly attributed variants",
    () => {
      // sessionID + ":" + base is identical for both pairs:
      // "ses_a" + ":" + ":x"  ==  "ses_a:" + ":" + "x"  ==  "ses_a::x"
      const sessionOne = session("ses_a")
      const sessionTwo = session("ses_a:")
      const baseOne = ":x"
      const baseTwo = "x"
      expect(Variant.variantId(sessionOne, baseOne)).toBe(Variant.variantId(sessionTwo, baseTwo))

      const agentOne = makeAgent(baseOne)
      const agentTwo = makeAgent(baseTwo)
      const manager = Variant.make()
      manager.synchronize(
        snapshot(
          [agentOne, agentTwo],
          [
            redirect(baseOne, "openai/gpt-5.1", sessionOne),
            redirect(baseTwo, "anthropic/claude-4-5", sessionTwo),
          ],
        ),
      )

      const idOne = manager.variantFor(sessionOne, baseOne)
      const idTwo = manager.variantFor(sessionTwo, baseTwo)
      expect(idOne).toBeDefined()
      expect(idTwo).toBeDefined()
      // The colliding digest is only a candidate: `allocate`'s taken-set check
      // (keyed on the final id, not on why two candidates coincide) pushes
      // whichever pair is processed second to its next salted candidate, so the
      // two sessions still end up with distinct hidden agents.
      expect(idOne).not.toBe(idTwo)

      const { draft, map } = makeDraft([agentOne, agentTwo])
      manager.apply(draft)
      // Each session's own override, not the other one's, reached its variant.
      expect(modelOf(map.get(idOne ?? ""))).toBe("openai/gpt-5.1")
      expect(modelOf(map.get(idTwo ?? ""))).toBe("anthropic/claude-4-5")
    },
  )

  test("a NUL byte inside an overridden agent's name cannot alias another session's assignment", () => {
    // These pairs collide under a NUL-delimited string key. The manager uses
    // an injective JSON tuple encoding instead, so both assignments survive.
    const sessionOne = session("ses_a")
    const sessionTwo = session("ses_a\u0000")
    const baseOne = "\u0000y"
    const baseTwo = "y"

    const agentOne = makeAgent(baseOne)
    const agentTwo = makeAgent(baseTwo)
    const manager = Variant.make()
    manager.synchronize(
      snapshot(
        [agentOne, agentTwo],
        [
          redirect(baseOne, "openai/gpt-5.1", sessionOne),
          redirect(baseTwo, "anthropic/claude-4-5", sessionTwo),
        ],
      ),
    )

    // Both sessions set an override of their own; each must resolve to its
    // own, distinct variant rather than sharing one.
    expect(manager.list().length).toBe(2)
    expect(manager.variantFor(sessionOne, baseOne)).not.toBe(
      manager.variantFor(sessionTwo, baseTwo),
    )
  })
})
