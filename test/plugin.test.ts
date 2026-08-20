import { describe, expect, test } from "bun:test"
import plugin, { Registry, Spawn, Store, Tools, Variant } from "../src/index.ts"

/**
 * Importing the entrypoint is itself the assertion: it resolves the plugin API
 * subpaths this plugin depends on, which a unit test of the core modules alone
 * would not exercise.
 */
describe("plugin entrypoint", () => {
  test("declares the documented id", () => {
    expect(plugin.id).toBe("opencode2-agent-model-override")
  })

  test("setup is an effect factory, so nothing runs at import time", () => {
    expect(typeof plugin.effect).toBe("function")
  })

  test("re-exports the core modules for tests and reuse", () => {
    expect(typeof Registry.make).toBe("function")
    expect(typeof Store.make).toBe("function")
    expect(typeof Tools.all).toBe("function")
    expect(typeof Variant.make).toBe("function")
    expect(typeof Variant.variantId).toBe("function")
    expect(typeof Spawn.route).toBe("function")
  })
})
