import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { CatalogModel, ModelReference } from "../src/domain.ts"
import * as ModelRef from "../src/model.ts"

const parse = (input: string) => Effect.runSyncExit(ModelRef.parse(input))

/**
 * Widens the branded `Model.Ref` fields to plain strings.
 *
 * `Model.Ref` carries `Brand<"Provider.ID">` and friends, which no string
 * literal satisfies, so comparing against one directly does not typecheck.
 * This is a plain assignment, not a cast: a branded string is already a
 * `ModelReference`.
 */
const widen = (ref: ModelReference): ModelReference => ref

const catalog: ReadonlyArray<CatalogModel> = [
  {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
    modelID: "claude-sonnet-4-5",
    variants: [{ id: "thinking" }],
  },
  { providerID: "openai", id: "gpt-5.1", modelID: "gpt-5.1", variants: [] },
  // Some providers namespace the catalog id differently from the model id.
  {
    providerID: "github-copilot",
    id: "claude-sonnet-4.5",
    modelID: "claude-sonnet-4.5-copilot",
    variants: [],
  },
]

describe("ModelRef.parse", () => {
  test("splits provider and model", () => {
    const exit = parse("anthropic/claude-sonnet-4-5")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(widen(exit.value).providerID).toBe("anthropic")
    expect(widen(exit.value).id).toBe("claude-sonnet-4-5")
    expect(widen(exit.value).variant).toBeUndefined()
  })

  test("keeps slashes inside the model id", () => {
    const exit = parse("openrouter/anthropic/claude-sonnet-4.5")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(widen(exit.value).providerID).toBe("openrouter")
    expect(widen(exit.value).id).toBe("anthropic/claude-sonnet-4.5")
  })

  test("reads a variant", () => {
    const exit = parse("anthropic/claude-sonnet-4-5#thinking")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(widen(exit.value).variant).toBe("thinking")
  })

  test("trims surrounding whitespace", () => {
    const exit = parse("  openai/gpt-5.1  ")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(widen(exit.value).providerID).toBe("openai")
    expect(widen(exit.value).id).toBe("gpt-5.1")
  })

  for (const input of ["", "   ", "anthropic", "/claude", "anthropic/", "anthropic/claude#"]) {
    test(`rejects ${JSON.stringify(input)} with a typed failure`, () => {
      const exit = parse(input)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      // A typed ModelError, not a thrown exception escaping Model.Ref.parse.
      const error = Effect.runSync(
        ModelRef.parse(input).pipe(
          Effect.flip,
          Effect.orElseSucceed(() => undefined),
        ),
      )
      expect(error?.display).toContain("provider/model")
    })
  }
})

describe("ModelRef.format", () => {
  test("round trips a reference without a variant", () => {
    expect(ModelRef.format({ providerID: "openai", id: "gpt-5.1" })).toBe("openai/gpt-5.1")
  })

  test("round trips a reference with a variant", () => {
    expect(
      ModelRef.format({ providerID: "anthropic", id: "claude-sonnet-4-5", variant: "thinking" }),
    ).toBe("anthropic/claude-sonnet-4-5#thinking")
  })

  test("survives parse then format", () => {
    for (const input of [
      "openai/gpt-5.1",
      "anthropic/claude-sonnet-4-5#thinking",
      "openrouter/anthropic/claude-sonnet-4.5",
    ]) {
      expect(ModelRef.format(Effect.runSync(ModelRef.parse(input)))).toBe(input)
    }
  })
})

describe("ModelRef.canonical", () => {
  const copilot = catalog[2]

  test("replaces a modelID alias with the catalog entry's own id", () => {
    expect(copilot).toBeDefined()
    if (copilot === undefined) return
    // The caller named the model by its provider `modelID`; what gets stored
    // has to be the id OpenCode resolves.
    expect(ModelRef.format(ModelRef.canonical(copilot, undefined))).toBe(
      "github-copilot/claude-sonnet-4.5",
    )
  })

  test("keeps the requested variant", () => {
    const sonnet = catalog[0]
    expect(sonnet).toBeDefined()
    if (sonnet === undefined) return
    const variant = Effect.runSync(ModelRef.parse("anthropic/claude-sonnet-4-5#thinking")).variant
    expect(ModelRef.format(ModelRef.canonical(sonnet, variant))).toBe(
      "anthropic/claude-sonnet-4-5#thinking",
    )
  })

  test("is a no-op for a reference that already used the catalog id", () => {
    const gpt = catalog[1]
    expect(gpt).toBeDefined()
    if (gpt === undefined) return
    expect(ModelRef.format(ModelRef.canonical(gpt, undefined))).toBe("openai/gpt-5.1")
  })
})

describe("ModelRef.find / hasVariant", () => {
  test("matches on the catalog id", () => {
    const found = ModelRef.find(catalog, { providerID: "openai", id: "gpt-5.1" })
    expect(found?.modelID).toBe("gpt-5.1")
  })

  test("matches on the provider model id", () => {
    const found = ModelRef.find(catalog, {
      providerID: "github-copilot",
      id: "claude-sonnet-4.5-copilot",
    })
    expect(found?.id).toBe("claude-sonnet-4.5")
  })

  test("does not match across providers", () => {
    expect(
      ModelRef.find(catalog, { providerID: "openai", id: "claude-sonnet-4-5" }),
    ).toBeUndefined()
  })

  test("ignores the variant when locating the model", () => {
    const found = ModelRef.find(catalog, {
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "nonsense",
    })
    expect(found).toBeDefined()
    if (found === undefined) return
    expect(ModelRef.hasVariant(found, "thinking")).toBe(true)
    expect(ModelRef.hasVariant(found, "nonsense")).toBe(false)
  })
})
