import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Effect, Schema } from "effect"
import { type CatalogModel, type ModelReference, reasonOf } from "./domain.ts"

export class ModelError extends Schema.TaggedError<ModelError>()(
  "opencode2-agent-model-override/ModelError",
  {
    input: Schema.String,
    reason: Schema.String,
  },
) {
  get display(): string {
    return (
      `${JSON.stringify(this.input)} is not a model reference (${this.reason}). ` +
      'Use "provider/model", e.g. "anthropic/claude-sonnet-4-5", or "provider/model#variant".'
    )
  }
}

/**
 * Parses the canonical `provider/model` or `provider/model#variant` syntax.
 *
 * Delegates to the schema's own parser rather than splitting the string here,
 * so the plugin accepts exactly what the rest of OpenCode accepts.
 */
export const parse = (input: string): Effect.Effect<Model.Ref, ModelError> => {
  const trimmed = input.trim()
  if (trimmed === "") {
    return Effect.fail(new ModelError({ input, reason: "it is empty" }))
  }
  return Effect.try({
    try: () => Model.Ref.parse(trimmed),
    catch: (cause) => new ModelError({ input: trimmed, reason: reasonOf(cause) }),
  })
}

export const format = (ref: ModelReference): string =>
  `${ref.providerID}/${ref.id}${ref.variant === undefined ? "" : `#${ref.variant}`}`

/** The catalog entry a reference points at, ignoring its variant. */
export const find = <Entry extends CatalogModel>(
  models: Iterable<Entry>,
  ref: ModelReference,
): Entry | undefined => {
  for (const model of models) {
    if (model.providerID !== ref.providerID) continue
    if (model.id === ref.id || model.modelID === ref.id) return model
  }
  return undefined
}

export const hasVariant = (model: CatalogModel, variant: string): boolean =>
  model.variants.some((candidate) => candidate.id === variant)

/**
 * The reference to store for a catalog entry the caller named.
 *
 * `find` accepts a provider's own `modelID` as an alias for the catalog `id`.
 * Persisting that alias would leave an id in the state file that the rest of
 * OpenCode does not resolve, so the entry's own `providerID` and `id` are
 * stored instead, keeping the variant that was validated against this entry.
 *
 * `Provider.ID`, `Model.ID` and `Model.Ref` are plain branded shapes with no
 * further checks, so these constructors cannot fail.
 */
export const canonical = (model: CatalogModel, variant: Model.Ref["variant"]): Model.Ref =>
  Model.Ref.make({
    providerID: Provider.ID.make(model.providerID),
    id: Model.ID.make(model.id),
    ...(variant === undefined ? {} : { variant }),
  })
