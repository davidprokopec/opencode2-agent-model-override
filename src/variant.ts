import { createHash } from "node:crypto"
import type { AgentDraft } from "@opencode-ai/plugin/effect/agent"
import { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"

/**
 * A source agent paired with the model one session's override redirects it to.
 *
 * Declared structurally rather than importing `Registry.SessionOverride`, so
 * this module stays a leaf that the registry and the tools can both depend on.
 */
export interface Redirect {
  readonly sessionID: Session.ID
  readonly agent: string
  readonly model: Model.Ref
}

/** What this plugin materializes for one session's override. */
export interface Variant {
  /** The session whose override this variant carries. */
  readonly sessionID: Session.ID
  /** Id of the source agent the user named. */
  readonly base: string
  /** Id of the hidden agent a redirected spawn actually targets. */
  readonly id: string
  readonly model: Model.Ref
}

/**
 * Longest source-derived prefix in a variant id.
 *
 * `50 + "-mo-".length + 8` is 62, and the collision escape below adds two more,
 * so every generated id stays within 64 characters.
 */
const PREFIX_LIMIT = 50
const MARKER = "-mo-"
const DIGEST_LENGTH = 8

/**
 * How many salted candidates are tried before an override is given up on.
 *
 * Each salt is a fresh eight hex character digest, so needing even the second
 * one means an agent is already named exactly like the first. Sixteen is far
 * past the point where a further attempt says anything but "the ids are being
 * chosen adversarially".
 */
const SALT_LIMIT = 16

const digestOf = (sessionID: Session.ID, base: string, salt: number): string =>
  createHash("sha256")
    .update(
      salt === 0
        ? `opencode2-agent-model-override:${sessionID}:${base}`
        : `opencode2-agent-model-override:${sessionID}:${base}#${salt}`,
    )
    .digest("hex")
    .slice(0, DIGEST_LENGTH)

/**
 * The id of the hidden agent that carries one session's override of `base`.
 *
 * The session is part of the hashed input, not decoration: two sessions that
 * override the same agent to different models each need a variant of their own
 * in one location-scoped agent registry, and an id derived from the agent alone
 * would give them the same one.
 *
 * Deterministic, so the same override always resolves to the same agent across
 * reloads and restarts, and so a user can name it in a permission rule. The
 * readable prefix keeps it recognisable in a session header; the hash keeps two
 * agents whose ids differ only in characters the prefix drops (`my.agent` and
 * `my-agent`) apart. Restricted to lowercase letters, digits and dashes, which
 * every agent id syntax in OpenCode accepts.
 *
 * `salt` selects a further candidate for the same source, used only when an
 * agent already holds the one before it. It changes the digest, not the length,
 * so every candidate stays inside the same budget.
 */
export const variantId = (sessionID: Session.ID, base: string, salt = 0): string => {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, PREFIX_LIMIT)
    .replace(/^-+|-+$/g, "")
  const prefix = slug === "" ? "agent" : slug
  const candidate = `${prefix}${MARKER}${digestOf(sessionID, base, salt)}`
  // A source agent already named exactly like its own variant would otherwise
  // make the transform overwrite the agent it is meant to copy.
  return candidate === base ? `${candidate}-x` : candidate
}

/**
 * The first candidate id for one session's override of `base` that no other
 * agent holds.
 *
 * `undefined` when every candidate is taken, in which case the override stays
 * dormant: a variant is worth having only if it can be created without
 * overwriting an agent someone else defined.
 */
const allocate = (
  sessionID: Session.ID,
  base: string,
  taken: ReadonlySet<string>,
): string | undefined => {
  for (let salt = 0; salt <= SALT_LIMIT; salt += 1) {
    const candidate = variantId(sessionID, base, salt)
    if (candidate !== base && !taken.has(candidate)) return candidate
  }
  return undefined
}

/**
 * Variants are keyed by session and source agent, which is what lets two
 * sessions hold an override of one agent independently of each other.
 */
const keyOf = (sessionID: Session.ID, base: string): string => JSON.stringify([sessionID, base])

export interface Interface {
  /**
   * Replaces the snapshot of source agents, the overrides, and the id each
   * override's variant is materialized under.
   *
   * `sources` is what `ctx.agent.list()` returned, so it holds agents as the
   * config and every other transform resolved them. `occupied` is every agent
   * id OpenCode currently resolves, which is what a generated id has to stay
   * clear of. The ids this manager currently holds are dropped from both, so a
   * variant is neither copied as a source nor treated as blocking its own id;
   * an id it no longer holds counts as occupied again, because by then only a
   * real agent can be answering to it.
   */
  readonly synchronize: (input: {
    readonly sources: ReadonlyArray<Agent.Info>
    readonly overrides: ReadonlyArray<Redirect>
    readonly occupied: ReadonlyArray<string>
  }) => void
  /**
   * Upserts one hidden variant per session's override into the draft.
   *
   * Registered as an agent transform, so it runs again after every reload. It
   * never reads or writes the source agent: OpenCode's own config transform
   * runs at an order this plugin does not control and would overwrite any
   * change to an existing id.
   */
  readonly apply: (draft: AgentDraft) => void
  /**
   * The variant id for a source agent as one session overrode it, or
   * `undefined` when none is materialized — because that session set no
   * override, because no agent of that name is defined here, or because no
   * legal id was free for it.
   */
  readonly variantFor: (sessionID: Session.ID, base: string) => string | undefined
  /** Whether an agent id is one this manager put into a draft. */
  readonly isVariant: (id: string) => boolean
  readonly list: () => ReadonlyArray<Variant>
}

export const make = (): Interface => {
  let sources: ReadonlyMap<string, Agent.Info> = new Map()
  /** The variant each override is materialized as, keyed by session and source id. */
  let assigned: ReadonlyMap<string, Variant> = new Map()

  return {
    synchronize: ({ sources: listed, overrides: redirects, occupied }) => {
      const held = new Set([...assigned.values()].map((variant) => variant.id))

      const snapshot = new Map<string, Agent.Info>()
      for (const agent of listed) {
        if (held.has(agent.id)) continue
        snapshot.set(agent.id, agent)
      }

      const taken = new Set<string>()
      for (const id of occupied) {
        if (held.has(id)) continue
        taken.add(id)
      }

      const next = new Map<string, Variant>()
      for (const redirect of redirects) {
        // An override for an agent this OpenCode does not define stays dormant
        // rather than inventing an agent out of nothing.
        if (!snapshot.has(redirect.agent)) continue
        const id = allocate(redirect.sessionID, redirect.agent, taken)
        if (id === undefined) continue
        taken.add(id)
        next.set(keyOf(redirect.sessionID, redirect.agent), {
          sessionID: redirect.sessionID,
          base: redirect.agent,
          id,
          model: redirect.model,
        })
      }

      sources = snapshot
      assigned = next
    },

    apply: (draft) => {
      for (const variant of assigned.values()) {
        const source = sources.get(variant.base)
        if (source === undefined) continue
        draft.update(variant.id, (info) => {
          // `structuredClone` gives the variant its own copy of every resolved
          // field — prompt, description, request, permissions, steps and
          // anything a later schema adds — with no nested reference shared with
          // the source. `Object.assign` then replaces only identity, model and
          // visibility; the checked `identity` literal is what constrains those.
          const identity = {
            id: Agent.ID.make(variant.id),
            name: Agent.Name.make(variant.id),
            model: { ...variant.model },
            hidden: true,
            mode: "subagent",
          } satisfies Pick<Agent.Info, "id" | "name" | "model" | "hidden" | "mode">
          Object.assign(info, structuredClone(source), identity)
        })
      }
    },

    variantFor: (sessionID, base) => assigned.get(keyOf(sessionID, base))?.id,

    isVariant: (id) => [...assigned.values()].some((variant) => variant.id === id),

    list: () => [...assigned.values()],
  }
}
