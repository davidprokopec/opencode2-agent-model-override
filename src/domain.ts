import { Schema } from "effect"

/**
 * The parts of `Agent.Info` this plugin reads.
 *
 * Declared structurally rather than importing `Agent.Info` so the core logic
 * and its tests do not have to build a fully branded agent record.
 */
export interface AgentSummary {
  readonly id: string
  readonly name: string
  readonly mode: "subagent" | "primary" | "all"
  readonly model?: ModelReference | undefined
}

/** The parts of `Model.Info` this plugin reads, structural for the same reason. */
export interface CatalogModel {
  readonly providerID: string
  /** Catalog id, which for most providers equals `modelID`. */
  readonly id: string
  readonly modelID: string
  readonly variants: ReadonlyArray<{ readonly id: string }>
}

export interface ModelReference {
  readonly providerID: string
  readonly id: string
  readonly variant?: string | undefined
}

/** A read of the running OpenCode server failed; never fatal to the plugin. */
export class LookupError extends Schema.TaggedError<LookupError>()(
  "opencode2-agent-model-override/LookupError",
  {
    resource: Schema.String,
    reason: Schema.String,
  },
) {
  get display(): string {
    return `could not read ${this.resource}: ${this.reason}`
  }
}

export const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
