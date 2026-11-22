# @lazurio/module-kit

Runtime helpers for Apps that follow the **Lazurio Module Standard**: read the
listener a Lazurio Platform assigned, answer health, shut down cleanly on
`SIGTERM`, learn who came to the App and with which application role, and
offer the App's tools to agents through `/mcp` and WebMCP.

This is the **only shared runtime library of a Module**. It stays small on
purpose: reading the runtime environment, health, shutdown and dev server
options, and the one tool contract for agents. It is not a framework, it has
no runtime dependencies, and anything beyond that belongs in the Module itself.

## Install

```sh
bun add github:Lazurio/module-kit#v0.4.0
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

| `appAccess(request, id = "app", env)` | who came to the App for this request and with which application role: always `{ entry, appRole, person, source, reason }`, see [Who came and with which role](#who-came-and-with-which-role) |
| `isLazurioUsername(value)` | whether a value is a Lazurio username (3–39 lowercase letters and digits, single dashes between them, not UUID-shaped, not a service account) |

`ModuleKitError.code` is one of `listener-missing`, `listeners-invalid` or
`environment-missing`.

## Who came and with which role

Lazurio decides who may open a Module's App and with which application role,
Application Admin or Application User, and the Organization decides in the
Module's code what each role may do (Lazurio decisions 0231 and 0234).
`appRole` carries the role as a stable value, `"admin"` for the Application
Admin and `"user"` for the Application User; the values do not change with the
names. `appAccess` is the only way a Module learns it, and its answer is the
stable contract: its fields and values never change meaning or disappear, and
new information comes as new fields. The contract is the Module Standard's
"Who came and with which role" in Lazurio Platform (`docs/module-standard.md`).

```ts
import { appAccess } from "@lazurio/module-kit";

// inside Bun.serve fetch(request), on every request, including APIs
const access = appAccess(request, "app");
if (access.appRole === null)
  return new Response("Lazurio did not say who you are.", { status: 403 });
const mayApprove = access.appRole === "admin"; // the Organization's own rule
const author = access.person?.subject ?? null; // null: from inside the Environment
```

Every answer has the same five fields:

| `entry` | `appRole` | `person` | `source` | `reason` | When |
| --- | --- | --- | --- | --- | --- |
| `environment` | `admin` | subject and username | `gateway` | `null` | the person has the whole Environment where the App runs |
| `app` | `admin` or `user` | subject and username | `gateway` | `null` | the person has this App only, with the application role the Organization gave them |
| `local` | `admin` | `null` | `null` | `not-hosted`, `not-through-gateway`, `local-entry` | from inside the Environment: no gateway in front of the App (a person's own computer), a request to a loopback address (a sibling, a script, an agent), or the Environment browser's local entry |
| `unknown` | `null` | `null` | `null` | `no-identity` | through the gateway without a valid statement, or a `Host` that is neither the App's hostname nor loopback: no role, show "unavailable" |

`source` says who stated the person: `gateway` today, from its own admission
answer after removing every copy a client sent; an identity signed by Lazurio
Auth for use outside the Environment will come as `auth`. A request whose
`Host` names the App's external hostname, in any letter case, with any port or
a trailing dot, as the gateway matches it, counts only by the gateway's
statement; a missing, repeated or malformed statement is `unknown`, never a
role.

- **Enforce on the server, per request.** Check the role for every request,
  including APIs, downloads, WebSockets and direct URLs, never only by hiding a
  button, and never cache it: after another account signs in, the next request
  names the new person.
- **Remember a person by `subject`**, show `username` (`null` when the gateway
  named none). Never fill in a name from the browser, the operating system
  account or the Environment's Assigned User.
- **Finer roles are the Module's.** Approvers, technicians and the like live in
  the Module's own data, keyed by `subject`. Lazurio keeps only the two
  application roles, Application Admin and Application User.
- **Its boundary is the Environment.** A process on the Environment that reaches
  the App's loopback port could send anything, as it could read the App's data.
  The statement holds against visitors who have only the App, not against the
  Environment's operator. Do not forward it to a sibling or another service.
- **Transport is not the contract.** `GATEWAY_HEADERS` names the headers the
  gateway uses today so that a Module's own tests can build requests; read them
  only through `appAccess`.

**Proof through the real gateway.** `bun proof/gateway.ts <Machines checkout>`
renders the Lazurio workspace gateway from a Machines checkout, runs it with
Caddy in front of a TypeScript App and a Python App and checks every Host form
a client can send: the App's hostname as is, in upper case, with `:443` or
another port (the gateway's statement counts: `environment`/`admin` with a
person, `unknown` without one, nothing without a session) and with a trailing
dot (refused by the gateway itself). A client's forged statement never counts
and no request through the gateway is `local`. It needs Caddy, OpenSSL and uv,
so it is not part of `bun test`.

Python: `app_access(headers, "app")` takes the request headers as a mapping
(matched case-insensitively; a repeated header reads as none) and returns
`AppAccess(entry, app_role, person, source, reason)` with
`AppPerson(subject, username)` or `None`, by the same rules; `app_role` takes
the same values, `"admin"` for the Application Admin and `"user"` for the
Application User.

## Tools for agents

An App defines its tools once, on its server, and offers them through two
transports over the same handler (Module Standard, "Agents in the App"):

- `/mcp`: a stateless MCP server (Streamable HTTP, JSON answers, POST only, no
  batches, body bounded to 64 KiB) behind the Application host's gateway, which
  admits a Lazurio Auth Bearer token with the application's role;
- the page: `GET /api/agent-tools` lists the tools for the person who has the
  page open and `POST /api/agent-tools/<name>` calls one with the page's own
  session (only from the App's own origin). `@lazurio/module-kit/webmcp`
  registers them as WebMCP tools, so an agent with the App open in the
  Environment browser calls them directly.

Both read who came only through `appAccess`, list only the tools the role and
the writer mode allow, and refuse with the same codes. Every registry also
answers `get_app_context`: module, version, data generation, `production` or
`environment`, entry, role and whether the caller may change data now.

```ts
import { z } from "zod";
import { createToolRegistry, defineTool } from "@lazurio/module-kit/tools";

const FindInput = z.strictObject({ query: z.string().max(200) });

const registry = createToolRegistry({
  app: { module: "revisions", version: "1.4.0", dataGeneration: "v3" },
  tools: [
    defineTool({
      name: "find_revisions",
      description: "Najde revize podle čísla, zákazníka nebo adresy.",
      input: FindInput,
      inputSchema: z.toJSONSchema(FindInput, { io: "input" }),
      minRole: "user",
      effect: "read",
      untrustedContent: true,
      // The same domain service the interface calls, never the data files.
      run: async ({ query }, { access }) => ({
        ok: true,
        data: { items: await revisions.find(query, access) },
      }),
    }),
  ],
});

Bun.serve({
  hostname: host,
  port,
  fetch: withHealth(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return registry.handleMcp(request);
    return (await registry.handlePage(request)) ?? app(request);
  }),
});
```

On the page:

```ts
import { registerAgentTools } from "@lazurio/module-kit/webmcp";

const tools = await registerAgentTools({
  // View tools of the page never change data.
  viewTools: [{ name: "open_revision", description: "Otevře revizi.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    execute: ({ id }) => router.open(id) }],
});
// After a sign-in or a role change: await tools.refresh();
```

**Effects** (Lazurio Module Standard, "Effects and publication"; decision D1
of LZD-0037). `read` changes nothing (finding, reading, computing, producing a
file such as a PDF) and is offered in the read-only mode as well. `prepare`
changes no shared data and prepares a step a person completes in the
interface. `write` is a draft: a reversible change that publishes nothing, which
an agent makes on its own. `publish` is a publication: an irreversible step or
one others see (an approval, a signature, a sending, a deletion, a movement of
money, the publication of a draft or of data to everyone). An agent calls it
on the person's "Publikuj". That word is an agreement between the person and
the agent, not a mechanism the App checks (the Owner, 2026-11-22), so **a
production application offers its publications to agents** as a development
version does, on `/mcp` and on the page. A publication is a tool of its own,
never a mode of a draft tool, and the registry gives it `destructiveHint: true`
itself. A draft and a publication are offered only while `dataWriter` allows
writing (`LAZURIO_RUNTIME_DATA_WRITER=true`; unset, never in a runtime that
states `LAZURIO_RUNTIME_DEPLOYMENT=production`, else only to a local or
Environment entry). The App records who published and which way with the
change itself: the person is `context.access.person.subject` and the way is
`context.channel` (`mcp` or `webmcp`), as the Standard's "Author and channel"
says; the registry's audit line names them too, with the effect.
`AGENT_PUBLICATION_IN_PRODUCTION` is `true` and deprecated. A 0.4 declaration
of a publication (`effect: "write"` with `publishesData: true`, or
`publicationConsent`) is refused at registration.

**Answers and refusals.** A tool returns `{ ok: true, data, files? }` or
`{ ok: false, reason, message, current_revision?, details? }` and never throws
for an expected outcome. The common reasons are `identity_unavailable`,
`forbidden`, `unknown_tool`, `invalid_input`, `not_found`, `record_changed`
(with `current_revision`), `data_read_only`, `unavailable` and
`internal_error`; a Module adds domain reasons of its own. On `/mcp` a refusal
is a tool result with `isError` and `structuredContent`; a file is an embedded
resource. Every call writes one audit line (channel, tool, effect, entry,
subject, role, outcome, duration), never the input or the answer.

**A data layer that decides by the method.** Every tool call is a `POST`.
An App whose data layer chooses a read or a write path by the HTTP method asks
`registry.effectOf(request)` instead: the named tool's effect for `tools/call`
and page calls, `read` for other MCP methods and the manifest, and `null`
(treat as a write) for any other path or anything it cannot tell. It reads a copy, so the request stays
readable.

**Tests.** `@lazurio/module-kit/tools/testing` builds requests as the gateway
states them (`gatewayRequest`, `hostedEnvironment`, `localEnvironment`) and
calls the registry (`mcpCall`, `mcpToolNames`, `mcpTools`, `mcpTool`,
`pageTool`), so a Module tests the list per role, the refusal without a role,
writes in the read-only mode, `record_changed` on both transports, and that
each publication is listed with `destructiveHint: true` (`mcpTools`).

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
