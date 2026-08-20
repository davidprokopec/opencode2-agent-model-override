# Contributing

Contributions are welcome. Keep changes focused and open an issue before
starting work that changes spawn routing, variant identity, or storage.

## Development

Requirements:

- Bun 1.3.14
- the OpenCode V2 build pinned in `package.json`

```sh
bun install --frozen-lockfile
bun run check
```

The V2 plugin API is host-coupled. Do not update `@opencode-ai/*` or Effect as
an ordinary dependency bump; update them together and verify the plugin inside
the matching OpenCode release.

A variant id is part of the plugin's contract: it can be written into
configuration and into scoped permission rules. Do not change how it is derived
without treating it as a breaking change.

## Pull requests

1. Branch from `develop`.
2. Use a Conventional Commit pull request title, such as
   `fix: keep an override scoped to its own session`.
3. Add or update tests for behavior changes.
4. Run `bun run check`.
5. Open the pull request against `develop`.

Pull requests into `develop` are squash-merged. `master` only accepts the
release pull request from `develop`, using a merge commit. Direct pushes to
either protected branch are disabled.

## Releases

- Every eligible push to `develop` publishes a unique npm `dev` snapshot.
- A version tag on `master` publishes the reviewed npm `beta` release.
- Nothing publishes to npm `latest` while OpenCode V2 remains beta.

Maintainers prepare a reviewed release by merging `develop` into `master`, then
creating and pushing the version tag from `master`.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
