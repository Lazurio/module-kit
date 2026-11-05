# @lazurio/module-kit

Runtime helpers for Apps that follow the **Lazurio Module Standard**: read the
listener a Lazurio Platform assigned, answer health, shut down cleanly on
`SIGTERM`, and read who is signed in to Lazurio for a request.

This is the **only shared runtime library of a Module**. It stays small on
purpose: reading the runtime environment, health, shutdown and dev server
options. It is not a framework, it has no runtime dependencies, and anything
beyond that belongs in the Module itself.

## Install

```sh
bun add github:Lazurio/module-kit#v0.3.0
```

The package ships TypeScript sources (`exports` and `types` point at
`src/index.ts`). Bun runs them natively and there is no build step. The source
uses only erasable syntax and compiles under `strict`,
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## The rule it enforces

An App reads its host and port **only** from
`LAZURIO_RUNTIME_LISTENER_<ID>_HOST` and `LAZURIO_RUNTIME_LISTENER_<ID>_PORT`,
and its browser origin from `LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN`
(hosted entrypoint only). `<ID>` is the listener id upper-cased, with `-`
mapped to `_`. When a variable is missing or invalid, the helpers throw
`ModuleKitError` with code `listener-missing`, and the message names the exact
variable. They never fall back to `PORT`, `LAZURIO_RUNTIME_HOST`/`_PORT`, lease
files or defaults. The standard says such an App does not run and exits with
code 2:

```ts
import { type Listener, listener, ModuleKitError } from "@lazurio/module-kit";

let app: Listener;
try {
  app = listener("app");
} catch (error) {
  if (!(error instanceof ModuleKitError)) throw error;
  console.error(error.message);
  process.exit(2);
}
```

## API

| Function | Returns |
| --- | --- |
| `listener(id, env = process.env)` | `{ host, port, externalOrigin }` (`externalOrigin` is `null` unless hosted); throws `listener-missing` |
| `listeners(env)` | every listener as `{ id, host, port, externalOrigin }`, from `LAZURIO_RUNTIME_LISTENERS_JSON` when present, else derived from `LAZURIO_RUNTIME_LISTENER_*`; a malformed JSON value throws `listeners-invalid` |
| `runtimeIdentity(env)` | `{ schemaVersion, appId, entrypointId }` from `LAZURIO_RUNTIME_SCHEMA_VERSION`, `_APP_ID` and `_ENTRYPOINT_ID`, or `null` |
| `allowedHosts(id, env)` | the external origin's hostname (if any) plus `localhost`, `127.0.0.1` and `::1`; never a wildcard |
| `viteShutdownPlugin({ closeTimeoutMs = 2000 })` | Vite plugin: SIGTERM/SIGINT closes every connection, bounds `server.close()` and exits 0 (Vite alone reports 128 + signal and an open keep-alive connection can hold `close()`); use in `vite.config.ts` `plugins` for dev and preview |
| `viteServerOptions(id, env)` | `{ host, port, strictPort: true, allowedHosts }` for Vite `server` |
| `astroServerOptions(id, env)` | `{ host, port, allowedHosts }` for Astro `server` |
| `health(ready)` | `(req) => Promise<Response>`: 200 `{"status":"ok"}` when `ready()` is true, else (or when it throws) 503 `{"status":"starting"}` |
| `withHealth(handler, path = "/healthz", ready = () => true)` | a `Bun.serve` fetch handler that answers `path` with `health(ready)` and passes everything else on |
| `onShutdown(fn, { timeoutMs = 10_000 })` | on `SIGTERM`/`SIGINT`, runs `fn` once and exits 0; exits 1 if `fn` throws or does not finish within `timeoutMs`; returns a function that removes the handlers |
| `requireEnvironment(names, env)` | the values as a record; throws `environment-missing` naming every absent or empty variable |

| `signedInPerson(request, id = "app", env)` | who is signed in to Lazurio for this request: `{ status: "signed-in", subject, username }` or `{ status: "unavailable", reason }`, see [Who is signed in](#who-is-signed-in) |
| `isLazurioUsername(value)` | whether a value is a Lazurio username (3–39 lowercase letters and digits, single dashes between them, not UUID-shaped, not a service account) |

`ModuleKitError.code` is one of `listener-missing`, `listeners-invalid` or
`environment-missing`.

## Who is signed in

On a Remote Environment the Environment's gateway admits every request to a
Module with the person's Lazurio session and then sets two request headers
from its own admission answer: `X-Auth-Request-User`, the Lazurio account's
subject (a lowercase UUID), and `X-Auth-Request-Preferred-Username`, the
person's Lazurio username. Every copy a client sends is removed first. The
contract is the Module Standard's "Who is signed in" in Lazurio Platform
(`docs/module-standard.md`).

```ts
import { signedInPerson } from "@lazurio/module-kit";

// inside Bun.serve fetch(request)
const person = signedInPerson(request, "app");
if (person.status === "signed-in")
  return Response.json({ subject: person.subject, name: person.username });
return Response.json({ unavailable: person.reason });
```

- **Only behind the gateway.** The headers count only when the listener has an
  external origin (`LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN`, which the
  Platform passes on a Remote Environment) and the request's `Host` is that
  origin's host. On a person's computer the result is always
  `unavailable: not-hosted`, whatever the request carries; a request from a
  sibling or a script on the Environment is `not-through-gateway`; the
  Environment browser's local entry and a gateway without this capability give
  `no-person`. Show these honestly as "unavailable", never as a guessed name.
- **Per request.** Read it for each request and never cache it: after another
  account signs in, the next request names the new person, and an expired
  session never reaches the Module.
- **Remember a person by `subject`**, show `username`. `username` is `null`
  when the gateway named none.
- **Read-only.** It is identity for display and the Module's own rules: not a
  role, a grant, a key to data or a signature. Do not forward the headers to a
  sibling or another service.
- **Its boundary is the Environment.** Any process on the Environment that
  reaches the Module's loopback port could send the headers itself, like it
  could read the Module's data. Where identity must hold against the
  Environment's operator, it needs an identity signed by Lazurio Auth, which
  this helper does not provide.

Python: `signed_in_person(headers, "app")` takes the request headers as a
mapping (matched case-insensitively; a repeated header reads as none) and
returns `SignedIn(subject, username)` or `Unavailable(reason)`.

## Bun.serve

```ts
import { listener, onShutdown, withHealth } from "@lazurio/module-kit";

const { host, port } = listener("app");
let ready = false;

const server = Bun.serve({
  hostname: host,
  port,
  fetch: withHealth(() => new Response("hello"), "/healthz", () => ready),
});
ready = true;

onShutdown(async () => {
  await server.stop();
});
```

The `/healthz` path must match `lazurio.runtime.listeners[].health`.

## Vite

`vite build` has no listener, so read it only when serving:

```ts
// vite.config.ts
import { viteServerOptions } from "@lazurio/module-kit";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  ...(command === "serve" ? { server: viteServerOptions("app") } : {}),
}));
```

## Astro

Astro also evaluates `server` during `astro build`, so read it only for
`astro dev`:

```ts
// astro.config.ts
import { astroServerOptions } from "@lazurio/module-kit";
import { defineConfig } from "astro/config";

const dev = process.argv.includes("dev");

export default defineConfig({
  ...(dev ? { server: astroServerOptions("app") } : {}),
});
```

## Python

The `python/` directory holds `lazurio-module-kit`, the same `listener` and
`health` semantics for a Python Module (`uv` + `pyproject.toml`):

```sh
uv add "lazurio-module-kit @ git+https://github.com/Lazurio/module-kit@v0.3.0#subdirectory=python"
```

```python
import asyncio
import sys

from lazurio_module_kit import ModuleKitError, health, listener

try:
    app = listener("app")  # Listener(host, port, external_origin)
except ModuleKitError as error:
    print(error, file=sys.stderr)
    sys.exit(2)

check = health(lambda: True)
response = asyncio.run(check())  # HealthResponse(status, body, content_type)
```

`health` is framework-neutral: it returns the status, JSON body and content
type, and your server writes them.

## Development

```sh
bun install
bun run check   # tsc --noEmit + biome check
bun test

cd python
uv sync --frozen
uv run ruff check . && uv run pyright && uv run pytest
```

## License

MIT, Copyright (c) 2026 Lazurio.
