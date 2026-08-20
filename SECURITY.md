# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/davidprokopec/opencode2-agent-model-override/security/advisories/new).
Please do not open a public issue for a vulnerability.

## What this plugin can do

It runs inside the OpenCode background service with the same user privileges as
OpenCode itself. Specifically it:

- reads the agents and the model catalog OpenCode resolved, and registers
  hidden copies of those agents that differ only in their model,
- rewrites the requested agent id of a spawn made by a session that has an
  override, so the spawn runs as that session's hidden copy,
- stores every session's overrides as one plain JSON document,
  `${XDG_STATE_HOME:-~/.local/state}/opencode2-agent-model-override/overrides.json`,
  and
- exposes three model-facing tools that set, list, and clear those overrides.

It makes no network requests of its own, runs no shell commands, and reads no
credentials. It never modifies, replaces, or removes an agent it did not create.

## Trust boundary worth knowing

An override is a session id, an agent id, and a `provider/model` string in a
file. Anything able to write into the store directory can therefore make future
spawns from one of your sessions run on a provider of its choosing, using the
source agent's prompt, tools, and permissions and whatever credential that
provider is configured with. The directory sits under your user's home
directory and is protected by ordinary filesystem permissions; there is no
additional signing. On POSIX systems the plugin tightens its directory to
`0700` and state file to `0600`; Windows applies its native ACL semantics.
This is only a concern if you already share that account with something you do
not trust.

A redirected spawn runs under the hidden copy's agent id, not the original one,
so a permission rule scoped to the original id does not match it. Scope such
rules to the variant id, or to a pattern that covers it, before relying on them.
See the limitations section of the README.

An entry that does not parse is skipped rather than trusted. A malformed whole
document reads as no overrides rather than failing the plugin's load.

## Supply chain

Releases publish from GitHub Actions using npm trusted publishing (OIDC), so no
long-lived npm token remains after the one-shot bootstrap release. Published
versions carry npm provenance attestations. Verify with:

```sh
npm audit signatures
```

CI pins actions to commit SHAs and installs dependencies with
`--frozen-lockfile --ignore-scripts`.
