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

Merging to `main` opens or updates a release pull request. Merging _that_ tags a
GitHub Release and publishes the package, both in the same workflow run. It goes
to npm with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers), so
no npm token is stored in this repository either.

Publishing runs in the same workflow run that cuts the release, rather than
from a separate `on: release` trigger. That is deliberate: a release created
with the built-in `GITHUB_TOKEN` does not cascade into further workflow runs,
so a separate trigger would never fire and no personal access token is needed
to make one.

The one place that rule still shows is the release pull request itself, which
for the same reason does not get its own CI run. Its checks have to be started
by hand from the Actions tab before branch protection will let it merge.

## Design constraints

Two rules shape most review feedback here:

1. **Zero runtime dependencies.** The package must stay installable in Node, the
   browser, and React Native without pulling anything in. Auth schemes plug in
   through the `authProvider` hook rather than shipping an SDK.
2. **Nothing application-specific.** No project-specific header names, service
   names, or environment variable names in `src/`. If something only makes sense
   for one app, it belongs in that app's `authProvider` or in a README recipe.
