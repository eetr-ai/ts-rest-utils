# ts-rest-utils

A small, dependency-free REST client for TypeScript — typed responses, pluggable
auth, retries, and timeouts, on top of the platform `fetch`.

> **Status: under construction.** The package is being built out in stages; the
> API below is the intended shape, not yet a published surface. Follow the
> [releases](https://github.com/eetr-ai/ts-rest-utils/releases) for the first
> tagged version.

## What it is

Most projects end up hand-rolling the same wrapper around `fetch`: build a URL,
attach auth headers, encode a body, sniff the content type, decide what a
non-2xx means. Written once per app, these copies drift. This library is that
wrapper, extracted and hardened — with the parts that differ between apps
(auth, base URLs, logging, retry policy) exposed as configuration rather than
baked in.

It ships **zero runtime dependencies** and no auth SDKs. Every credential
scheme — bearer tokens, API keys, cloud identity tokens, OAuth 2.1
client-credentials — plugs in through a single `authProvider` hook, which is
what keeps the package usable from Node, the browser, and React Native alike.

## Installation

```bash
npm install @eetr/ts-rest-utils
```

## License

MIT — see [LICENSE](./LICENSE).
