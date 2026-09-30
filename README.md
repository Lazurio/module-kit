# @lazurio/module-kit

Runtime helpers for Apps that follow the **Lazurio Module Standard**: read the
listener a Lazurio Platform assigned, answer health, and shut down cleanly on
`SIGTERM`.

This is the **only shared runtime library of a Module**. It stays small on
purpose: reading the runtime environment, health, shutdown and dev server
options. It is not a framework, it has no runtime dependencies, and anything
beyond that belongs in the Module itself.

## Install

```sh
bun add github:Lazurio/module-kit#v0.1.0
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
| `viteServerOptions(id, env)` | `{ host, port, strictPort: true, allowedHosts }` for Vite `server` |
| `astroServerOptions(id, env)` | `{ host, port, allowedHosts }` for Astro `server` |
| `health(ready)` | `(req) => Promise<Response>`: 200 `{"status":"ok"}` when `ready()` is true, else (or when it throws) 503 `{"status":"starting"}` |
| `withHealth(handler, path = "/healthz", ready = () => true)` | a `Bun.serve` fetch handler that answers `path` with `health(ready)` and passes everything else on |
| `onShutdown(fn, { timeoutMs = 10_000 })` | on `SIGTERM`/`SIGINT`, runs `fn` once and exits 0; exits 1 if `fn` throws or does not finish within `timeoutMs`; returns a function that removes the handlers |
| `requireEnvironment(names, env)` | the values as a record; throws `environment-missing` naming every absent or empty variable |

`ModuleKitError.code` is one of `listener-missing`, `listeners-invalid` or
`environment-missing`.

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
uv add "lazurio-module-kit @ git+https://github.com/Lazurio/module-kit@v0.1.0#subdirectory=python"
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
