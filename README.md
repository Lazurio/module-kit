# @lazurio/module-kit

Runtime helpers for Apps that follow the **Lazurio Module Standard**: read the
listener a Lazurio Platform assigned, answer health, shut down cleanly on
`SIGTERM`, and learn who came to the App and with which application role.

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

| `appAccess(request, id = "app", env)` | who came to the App for this request and with which application role: `{ entry, appRole, person, source }` or, without a person, `{ entry, appRole, person: null, reason }`, see [Who came and with which role](#who-came-and-with-which-role) |
| `isLazurioUsername(value)` | whether a value is a Lazurio username (3–39 lowercase letters and digits, single dashes between them, not UUID-shaped, not a service account) |

`ModuleKitError.code` is one of `listener-missing`, `listeners-invalid` or
`environment-missing`.

## Who came and with which role

Lazurio decides who may open a Module's App and with which application role,
application admin or application user, and the Organization decides in the
Module's code what each role may do (Lazurio decision 0231). `appAccess` is the
only way a Module learns it, and its answer is the stable contract: its fields
and values never change meaning or disappear, and new information comes as new
fields. The contract is the Module Standard's "Who came and with which role"
in Lazurio Platform (`docs/module-standard.md`).

```ts
import { appAccess } from "@lazurio/module-kit";

// inside Bun.serve fetch(request), on every request, including APIs
const access = appAccess(request, "app");
if (access.appRole === null)
  return new Response("Lazurio did not say who you are.", { status: 403 });
const mayApprove = access.appRole === "admin"; // the Organization's own rule
const author = access.person?.subject ?? null; // null: from inside the Environment
```

| `entry` | `appRole` | `person` | When |
| --- | --- | --- | --- |
| `environment` | `admin` | subject and username | the person has the whole Environment where the App runs |
| `app` | `admin` or `user` | subject and username | the person has this App only, with the role the Organization gave them |
| `local` | `admin` | `null` | a request from inside the Environment: a person's own computer (`reason: "not-hosted"`), a sibling or a script on the Environment (`not-through-gateway`), the Environment browser's local entry (`local-entry`) |
| `unknown` | `null` | `null` | through the gateway without identity (`no-identity`), for example a gateway release without this capability: no role, show "unavailable" |

`source` is `gateway` today: the Environment's gateway states it from its own
admission answer after removing every copy a client sent. An identity signed by
Lazurio Auth for use outside the Environment will come as `source: "auth"`.

- **Enforce on the server, per request.** Check the role for every request,
  including APIs, downloads, WebSockets and direct URLs, never only by hiding a
  button, and never cache it: after another account signs in, the next request
  names the new person.
- **Remember a person by `subject`**, show `username` (`null` when the gateway
  named none). Never fill in a name from the browser, the operating system
  account or the Environment's assignee.
- **Finer roles are the Module's.** Approvers, technicians and the like live in
  the Module's own data, keyed by `subject`. Lazurio keeps only the two roles.
- **Its boundary is the Environment.** A process on the Environment that reaches
  the App's loopback port could send anything, as it could read the App's data.
  The statement holds against visitors who have only the App, not against the
  Environment's operator. Do not forward it to a sibling or another service.
- **Transport is not the contract.** `GATEWAY_HEADERS` names the headers the
  gateway uses today so that a Module's own tests can build requests; read them
  only through `appAccess`.

Python: `app_access(headers, "app")` takes the request headers as a mapping
(matched case-insensitively; a repeated header reads as none) and returns
`AppAccess(entry, app_role, person, source, reason)` with
`AppPerson(subject, username)` or `None`, by the same rules.

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

The `python/` directory holds `lazurio-module-kit`, the same `listener`,
`health` and `app_access` semantics for a Python Module (`uv` + `pyproject.toml`):

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
