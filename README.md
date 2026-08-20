# ts-rest-utils

[![CI](https://github.com/eetr-ai/ts-rest-utils/actions/workflows/ci.yml/badge.svg)](https://github.com/eetr-ai/ts-rest-utils/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@eetr/ts-rest-utils.svg)](https://www.npmjs.com/package/@eetr/ts-rest-utils)
[![license](https://img.shields.io/npm/l/@eetr/ts-rest-utils.svg)](./LICENSE)

A small REST client for TypeScript — typed responses, pluggable auth, retries,
and timeouts, on top of the platform `fetch`.

**No runtime dependencies.** The same code runs in Node, in a browser, and in
React Native, because nothing is pulled in and no credential SDK ships here.

```bash
npm install @eetr/ts-rest-utils
```

## Quick start

```ts
import { RestClient } from "@eetr/ts-rest-utils";

const api = new RestClient({ baseUrl: "https://api.example.com" });

const response = await api.get<User>("/users/me");

if (response.ok) {
  console.log(response.body.name);
}
```

## The response

A non-2xx is a value, not an exception. You decide at the call site what an
unsuccessful status means, instead of writing the same `if (status !== 200)`
block everywhere:

```ts
const response = await api.get<User[]>("/users");

response.getOrDefault([]); // the body, or [] if it failed
response.getOrNull(); // the body, or null
response.getOrThrow(); // the body, or throw an HttpError
response.getOrThrow(new NotFoundError()); // the body, or throw your own error

response.getOrDefault([], 201); // require exactly 201, not just any 2xx
```

`ok`, `status`, `bodyType`, `headers`, and the underlying `raw` response are all
available. The check is on the status, never on truthiness — an empty array from
a successful request is returned as-is, not swapped for the default.

Only a network failure, a timeout, or a cancellation throws.

## Authentication

Every credential scheme is an `authProvider`: an async function returning
headers, called once per attempt. The library ships none of them, which is what
keeps it dependency-free and usable everywhere.

```ts
// A bearer token
new RestClient({
  baseUrl: "https://api.example.com",
  authProvider: () => ({ Authorization: `Bearer ${getToken()}` }),
});

// An API key
new RestClient({
  baseUrl: "https://api.example.com",
  authProvider: () => ({ "X-Api-Key": process.env.API_KEY! }),
});
```

### Refreshing an expired credential

`onAuthFailure` runs when the server rejects the credential. Return `true` to
retry — the provider is called again, so a refreshed token is picked up.

```ts
new RestClient({
  baseUrl: "https://api.example.com",
  authProvider: () => ({ Authorization: `Bearer ${session.token}` }),
  retry: {
    onAuthFailure: async () => {
      const token = await session.refresh();
      return token !== null; // false gives up and returns the 401
    },
  },
});
```

Configuring `onAuthFailure` implies a second attempt, since a refresh with no
retry left could never use the new credential.

### A cloud identity token, per backend

`resolveBase` picks which backend a URL belongs to, so a provider can mint the
right credential for it. It matches on URL boundaries, not string prefixes, so
`https://api.example.com.somewhere-else.test` does not resolve to
`https://api.example.com`.

```ts
import { RestClient, resolveBase } from "@eetr/ts-rest-utils";
import { GoogleAuth } from "google-auth-library"; // your dependency, not ours

const services = {
  billing: process.env.BILLING_URL!,
  search: process.env.SEARCH_URL!,
};

const auth = new GoogleAuth();

const api = new RestClient({
  services,
  authProvider: async ({ url }) => {
    const audience = resolveBase(url, Object.values(services));
    if (!audience) return {};
    const client = await auth.getIdTokenClient(audience);
    return client.getRequestHeaders(url);
  },
});

await api.get("/invoices", { service: "billing" });
```

### Per-request context

`with()` derives a client carrying a context, instead of threading an extra
argument through every call. The library never inspects it.

```ts
const api = new RestClient<{ userId: string; locale: string }>({
  baseUrl: "https://api.example.com",
  authProvider: ({ context }) => ({
    "X-User-Id": context?.userId ?? "",
    "Accept-Language": context?.locale ?? "en",
  }),
});

const forRequest = api.with({ context: { userId, locale } });
await forRequest.get("/preferences");
```

## Options

| Option         | What it does                                                       |
| -------------- | ------------------------------------------------------------------ |
| `baseUrl`      | Prefix for relative paths                                          |
| `services`     | Named base URLs, reachable via `service` or `client.path()`        |
| `headers`      | Static headers, or a function called per request                   |
| `authProvider` | Supplies credential headers                                        |
| `context`      | Default per-request context handed to `authProvider`               |
| `fetch`        | The `fetch` to use — inject one in tests                           |
| `timeoutMs`    | Abort an attempt that runs long                                    |
| `retry`        | Retry policy (off unless configured)                               |
| `logger`       | Where to report requests; silent by default                        |
| `defaultInit`  | Extra `RequestInit` merged into every request                      |
| `decode`       | `auto`, `json`, `text`, `blob`, `arrayBuffer`, `stream`, or `none` |

Per-request options take the same shape, plus `method`, `body`, `query`,
`service`, `signal`, and `init`.

Headers layer in precedence order: `defaultInit` → body content type → client
`headers` → `authProvider` → per-call `headers`.

## Bodies

A plain object is JSON-encoded and gets a `Content-Type`. `FormData`, `Blob`,
`URLSearchParams`, streams, and strings are passed through untouched — notably,
`FormData` gets **no** `Content-Type`, because the runtime has to add the
multipart boundary itself.

Responses decode from their content type. `application/json; charset=utf-8` and
`application/vnd.api+json` both parse as JSON; `204`, `304`, and any answer to
`HEAD` decode to `undefined` rather than failing to parse an absent body.

## Retries

```ts
new RestClient({
  baseUrl: "https://api.example.com",
  retry: {
    attempts: 3,
    delayMs: 300,
    backoff: "exponential", // or "fixed"
    maxDelayMs: 10_000,
    retryOn: [429, 500, 502, 503, 504],
  },
});
```

A server's `Retry-After` is preferred when present, clamped to `maxDelayMs` so a
far-end value cannot park the caller indefinitely. `retryOn` also accepts a
predicate. When attempts run out the last response is returned, not thrown.

## Timeouts and cancellation

```ts
await api.get("/slow", { timeoutMs: 5_000 }); // throws TimeoutError
await api.get("/x", { signal: controller.signal }); // throws NetworkError
```

`timeoutMs` applies **per attempt**, and covers reading the body as well as
receiving the headers. For a deadline spanning retries, pass your own `signal`.

## URLs

```ts
import { buildUrl, createEndpoints, resolveBase, withQuery } from "@eetr/ts-rest-utils";

buildUrl("/users", "https://api.example.com"); // https://api.example.com/users
withQuery("https://api.example.com/s", { q: "a b", tag: ["x", "y"] });
// https://api.example.com/s?q=a+b&tag=x&tag=y

const endpoints = createEndpoints({ billing: "https://billing.example.com" });
endpoints.billing("/invoices");
```

`withQuery` skips `undefined` and `null` rather than serialising them, repeats a
key per array element, and inserts the query before any fragment.

## Logging

Silent unless you ask. `consoleLogger` reports one line per request and
response, and **redacts credentials** — in headers and in query strings alike,
keeping the names and replacing the values.

```ts
import { consoleLogger } from "@eetr/ts-rest-utils";

new RestClient({ baseUrl: "https://api.example.com", logger: consoleLogger() });
// [rest] GET https://api.example.com/users -> 200 (34ms)
```

Implement the `Logger` interface yourself to send the same events elsewhere;
`redactHeaders` and `redactUrl` are exported for that.

## Framework notes

**Next.js.** Runtime-specific `RequestInit` fields pass straight through:

```ts
new RestClient({
  baseUrl: process.env.API_URL!,
  defaultInit: { next: { revalidate: 60 } } as RequestInit,
});
```

**React Native.** Supported directly. Signals are composed with a plain
`AbortController` rather than `AbortSignal.any` or `AbortSignal.timeout`,
neither of which is reliably present on Hermes.

**Testing.** Inject a `fetch`:

```ts
const api = new RestClient({ baseUrl: "https://api.test", fetch: fakeFetch });
```

## Migrating from a hand-rolled wrapper

Most projects grow a `getApi`/`postApi` module around `fetch`. The compat layer
matches that shape, so adopting this can be an import change:

```ts
import { configure, getApi, postApi } from "@eetr/ts-rest-utils";

configure({ baseUrl: process.env.API_URL!, authProvider: myAuth });

const response = await getApi<User>("/users/me");
```

`APIResponse` is exported as an alias of `ApiResponse` for codebases that
spelled it that way. Prefer constructing a `RestClient` directly once you have
more than one backend, or in tests — shared mutable configuration is as awkward
here as anywhere.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
