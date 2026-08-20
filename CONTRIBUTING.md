# Contributing

Thanks for taking an interest. This is a small library and the setup is
deliberately boring.

## Getting started

```bash
npm ci
npm test
```

## Scripts

| Script                  | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `npm run build`         | Bundle ESM + CJS + type declarations into `dist/` with tsup    |
| `npm test`              | Run the Vitest suite once                                      |
| `npm run test:watch`    | Run Vitest in watch mode                                       |
| `npm run test:coverage` | Run the suite with a V8 coverage report                        |
| `npm run lint`          | Lint with [oxlint](https://oxc.rs/docs/guide/usage/linter)     |
| `npm run format`        | Format with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) |
| `npm run format:check`  | Check formatting without writing                               |
| `npm run typecheck`     | Type-check with `tsc --noEmit`                                 |

Before opening a pull request, run what CI runs:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

CI additionally runs `npm pack --dry-run`, to confirm the published tarball
contains only `dist/`, `README.md`, `LICENSE`, and the `package.json` npm always
includes — and runs the test suite against Node 20, 22, 24, and 26 rather than
only your local version.

## Commit and pull request titles

Releases are automated with
[release-please](https://github.com/googleapis/release-please), which reads
[Conventional Commits](https://www.conventionalcommits.org/) to decide the next
version and write the changelog.

Pull requests are **squash merged**, so the _pull request title_ becomes the
commit subject on `main`. That title is what release-please reads, and CI
rejects one that isn't conventional.

| Prefix                                         | Effect on the next release       |
| ---------------------------------------------- | -------------------------------- |
| `fix:`                                         | Patch bump                       |
| `feat:`                                        | Minor bump                       |
| `feat!:` or a `BREAKING CHANGE:` footer        | Major bump (minor while pre-1.0) |
| `chore:`, `docs:`, `test:`, `refactor:`, `ci:` | No release on their own          |

Examples:

```text
feat: add retry policy with configurable backoff
fix: decode application/json responses that carry a charset
docs: document the authProvider hook
```

## Releasing

Merging to `main` opens or updates a release pull request; merging _that_ tags a
GitHub Release, which triggers the publish workflow. The package is published to
npm with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers), so
there is no npm token stored in this repository.

One piece of setup makes that chain work end to end. GitHub deliberately does
not let the built-in `GITHUB_TOKEN` trigger further workflow runs, so a release
pull request it opens gets no CI checks — which branch protection requires — and
a release it publishes never starts `publish.yml`. Both restrictions lift with a
`RELEASE_PLEASE_TOKEN` repository secret holding a fine-grained personal access
token, scoped to this repository, with **contents: write**, **pull requests:
write**, and **issues: write**. Without it the workflow still runs, but releases
have to be published by hand to start publishing.

## Design constraints

Two rules shape most review feedback here:

1. **Zero runtime dependencies.** The package must stay installable in Node, the
   browser, and React Native without pulling anything in. Auth schemes plug in
   through the `authProvider` hook rather than shipping an SDK.
2. **Nothing application-specific.** No project-specific header names, service
   names, or environment variable names in `src/`. If something only makes sense
   for one app, it belongs in that app's `authProvider` or in a README recipe.
