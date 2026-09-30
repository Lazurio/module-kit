/**
 * @lazurio/module-kit — the one shared runtime library of a Lazurio Module.
 *
 * It reads the runtime environment a Lazurio Platform gives a started App
 * (LazurioPlatform decision F26) and answers health and shutdown the way the
 * Lazurio Module Standard requires. It never guesses: no `PORT`, no
 * `LAZURIO_RUNTIME_HOST/PORT`, no lease files, no defaults.
 */

type Environment = Readonly<Record<string, string | undefined>>;

export type ModuleKitErrorCode =
  | "listener-missing"
  | "listeners-invalid"
  | "environment-missing";

export class ModuleKitError extends Error {
  readonly code: ModuleKitErrorCode;

  constructor(code: ModuleKitErrorCode, message: string) {
    super(message);
    this.name = "ModuleKitError";
    this.code = code;
  }
}

export interface Listener {
  host: string;
  port: number;
  /** The browser origin (`https://<host>`), only for a hosted entrypoint. */
  externalOrigin: string | null;
}

export interface NamedListener extends Listener {
  id: string;
}

export interface RuntimeIdentity {
  schemaVersion: string;
  appId: string;
  entrypointId: string;
}

const PREFIX = "LAZURIO_RUNTIME_LISTENER_";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

/** The name part of a listener's variables: upper-cased, anything but a
 * letter or digit as `_` (the listener grammar allows only `-`). */
export function listenerVariableKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** Host, port and external origin of one declared listener, read from
 * `LAZURIO_RUNTIME_LISTENER_<ID>_HOST`, `_PORT` and `_EXTERNAL_ORIGIN`. */
export function listener(id: string, env: Environment = process.env): Listener {
  const prefix = `${PREFIX}${listenerVariableKey(id)}`;
  const hostName = `${prefix}_HOST`;
  const portName = `${prefix}_PORT`;
  const originName = `${prefix}_EXTERNAL_ORIGIN`;
  const host = env[hostName];
  if (host === undefined || host.trim() === "")
    throw new ModuleKitError(
      "listener-missing",
      `${hostName} is not set; start the App through Lazurio (lazurio module start)`,
    );
  const port = parsePort(env[portName]);
  if (port === null)
    throw new ModuleKitError(
      "listener-missing",
      env[portName] === undefined
        ? `${portName} is not set; start the App through Lazurio (lazurio module start)`
        : `${portName} is not a port (1-65535): ${JSON.stringify(env[portName])}`,
    );
  const rawOrigin = env[originName];
  if (rawOrigin === undefined || rawOrigin === "")
    return { host, port, externalOrigin: null };
  const externalOrigin = parseOrigin(rawOrigin);
  if (externalOrigin === null)
    throw new ModuleKitError(
      "listener-missing",
      `${originName} is not an origin (https://<host>, no path): ${JSON.stringify(rawOrigin)}`,
    );
  return { host, port, externalOrigin };
}

function invalidListeners(detail: string): ModuleKitError {
  return new ModuleKitError(
    "listeners-invalid",
    `LAZURIO_RUNTIME_LISTENERS_JSON ${detail}`,
  );
}

function listenerFromJson(entry: unknown, index: number): NamedListener {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    throw invalidListeners(`entry ${index} is not an object`);
  const record = entry as Record<string, unknown>;
  const { id, host, port } = record;
  const origin = record.external_origin;
  if (typeof id !== "string" || id === "")
    throw invalidListeners(`entry ${index} has no id`);
  if (typeof host !== "string" || host === "")
    throw invalidListeners(`listener ${id} has no host`);
  if (typeof port !== "number" || parsePort(String(port)) === null)
    throw invalidListeners(`listener ${id} has no valid port`);
  if (origin === undefined || origin === null)
    return { id, host, port, externalOrigin: null };
  if (typeof origin !== "string" || parseOrigin(origin) === null)
    throw invalidListeners(`listener ${id} has an invalid external_origin`);
  return { id, host, port, externalOrigin: origin };
}

/** Every listener of the App: from `LAZURIO_RUNTIME_LISTENERS_JSON` when
 * present, else derived from the `LAZURIO_RUNTIME_LISTENER_<ID>_*` names. */
export function listeners(env: Environment = process.env): NamedListener[] {
  const json = env.LAZURIO_RUNTIME_LISTENERS_JSON;
  if (json !== undefined && json !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw invalidListeners("is not valid JSON");
    }
    if (!Array.isArray(parsed)) throw invalidListeners("is not an array");
    return parsed.map(listenerFromJson);
  }
  const keys = Object.keys(env)
    .map((name) => /^LAZURIO_RUNTIME_LISTENER_([A-Z0-9_]+)_HOST$/.exec(name))
    .flatMap((match) => (match?.[1] === undefined ? [] : [match[1]]))
    .sort();
  // The listener grammar has no `_`, so `-` is the only reverse mapping.
  return keys.map((key) => ({
    id: key.toLowerCase().replaceAll("_", "-"),
    ...listener(key, env),
  }));
}

/** Which declared runtime and entrypoint this process is, or null when not
 * started by Lazurio. */
export function runtimeIdentity(
  env: Environment = process.env,
): RuntimeIdentity | null {
  const schemaVersion = env.LAZURIO_RUNTIME_SCHEMA_VERSION;
  const appId = env.LAZURIO_RUNTIME_APP_ID;
  const entrypointId = env.LAZURIO_RUNTIME_ENTRYPOINT_ID;
  if (!schemaVersion || !appId || !entrypointId) return null;
  return { schemaVersion, appId, entrypointId };
}

/** Hostnames a dev server accepts in `Host`: the listener's external origin
 * (when hosted) and loopback. Never a wildcard. */
export function allowedHosts(
  id: string,
  env: Environment = process.env,
): string[] {
  const { externalOrigin } = listener(id, env);
  const hosts: string[] =
    externalOrigin === null ? [] : [new URL(externalOrigin).hostname];
  for (const host of LOOPBACK_HOSTS)
    if (!hosts.includes(host)) hosts.push(host);
  return hosts;
}

/** Vite `server` options for one listener. */
export function viteServerOptions(
  id: string,
  env: Environment = process.env,
): { host: string; port: number; strictPort: true; allowedHosts: string[] } {
  const { host, port } = listener(id, env);
  return { host, port, strictPort: true, allowedHosts: allowedHosts(id, env) };
}

/** Astro `server` options for one listener. */
export function astroServerOptions(
  id: string,
  env: Environment = process.env,
): { host: string; port: number; allowedHosts: string[] } {
  const { host, port } = listener(id, env);
  return { host, port, allowedHosts: allowedHosts(id, env) };
}

export type Ready = () => boolean | Promise<boolean>;

/** A health handler: 200 `{"status":"ok"}` when `ready()` is true, else (or
 * when it throws) 503 `{"status":"starting"}`. */
export function health(ready: Ready): (req: Request) => Promise<Response> {
  return async () => {
    let ok = false;
    try {
      ok = (await ready()) === true;
    } catch {
      ok = false;
    }
    return Response.json(ok ? { status: "ok" } : { status: "starting" }, {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  };
}

/** Wraps a `Bun.serve` fetch handler so `path` answers health. The default
 * `ready` is true: a process that serves requests is ready. */
export function withHealth<Rest extends unknown[]>(
  handler: (req: Request, ...rest: Rest) => Response | Promise<Response>,
  path = "/healthz",
  ready: Ready = () => true,
): (req: Request, ...rest: Rest) => Response | Promise<Response> {
  const check = health(ready);
  return (req, ...rest) =>
    new URL(req.url).pathname === path ? check(req) : handler(req, ...rest);
}

export type ShutdownSignal = "SIGTERM" | "SIGINT";

/** The part of `process` that `onShutdown` uses; injectable for tests. */
export interface ShutdownProcess {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
}

export interface ShutdownOptions {
  timeoutMs?: number;
  process?: ShutdownProcess;
}

/** On SIGTERM or SIGINT, run `fn` once, then exit 0; exit 1 when it throws
 * or does not finish within `timeoutMs`. Further signals are ignored.
 * Returns a function that removes the signal handlers. */
export function onShutdown(
  fn: () => Promise<void> | void,
  options: ShutdownOptions = {},
): () => void {
  const target = options.process ?? process;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signals: ShutdownSignal[] = ["SIGTERM", "SIGINT"];
  let started = false;
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    target.exit(code);
  };
  const handle = () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      console.error(`Shutdown did not finish within ${timeoutMs} ms`);
      finish(1);
    }, timeoutMs);
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          clearTimeout(timer);
          finish(0);
        },
        (error: unknown) => {
          clearTimeout(timer);
          console.error("Shutdown failed:", error);
          finish(1);
        },
      );
  };
  for (const signal of signals) target.on(signal, handle);
  return () => {
    for (const signal of signals) target.off(signal, handle);
  };
}

// ---------------------------------------------------------------- dev servers

/** The subset of a Vite dev/preview server the shutdown plugin needs. */
export interface ClosableDevServer {
  httpServer?: { closeAllConnections?: () => void } | null;
  close(): Promise<void>;
}

/** Vite plugin: a requested stop (SIGTERM/SIGINT) closes the dev or preview
 * server and exits 0 (Lazurio Module Standard 4.4). Vite's own handler would
 * report 128 + signal, and an open keep-alive connection can hold `close()`
 * for longer than a Launchpad waits; every connection is closed first and
 * `close()` is bounded by `closeTimeoutMs`. Use in `vite.config.ts`:
 * `plugins: [react(), viteShutdownPlugin()]`. */
export function viteShutdownPlugin(
  options: { closeTimeoutMs?: number; shutdown?: ShutdownOptions } = {},
): {
  name: string;
  configureServer: (server: ClosableDevServer) => void;
  configurePreviewServer: (server: ClosableDevServer) => void;
} {
  const closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
  const attach = (server: ClosableDevServer) => {
    onShutdown(async () => {
      server.httpServer?.closeAllConnections?.();
      await Promise.race([
        server.close(),
        new Promise<void>((resolve) => setTimeout(resolve, closeTimeoutMs)),
      ]);
    }, options.shutdown ?? {});
  };
  return {
    name: "lazurio-module-kit-shutdown",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

/** Values of required variables; throws `environment-missing` naming every
 * absent or empty one. */
export function requireEnvironment<const Name extends string>(
  vars: readonly Name[],
  env: Environment = process.env,
): Record<Name, string> {
  const missing = vars.filter((name) => !env[name]);
  if (missing.length > 0)
    throw new ModuleKitError(
      "environment-missing",
      `Required environment not set: ${missing.join(", ")}`,
    );
  return Object.fromEntries(vars.map((name) => [name, env[name]])) as Record<
    Name,
    string
  >;
}
