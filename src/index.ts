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
  | "environment-missing"
  | "dev-frame-invalid";

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

/** One tag of the DEV frame: its name and its attributes. */
export interface DevFrameTag {
  tag: string;
  attrs: Record<string, string>;
}

/** The variable that names Lazurio's shell script to a DEV run: the agent
 * sets it when it starts the Module's app from a worktree, with the address
 * the Environment's manual gives; Lazurio removes it from every run it starts
 * itself (STAGING, PROD). Its presence is what makes a run DEV, so a Module
 * cannot turn the frame on anywhere else. */
export const SHELL_SCRIPT_VARIABLE = "LAZURIO_RUNTIME_SHELL_SCRIPT";

export interface DevFrameOptions {
  /** The frame's language, as `lang` of `<lazurio-buddy>`: a BCP 47 tag. */
  readonly lang?: string;
}

const SHELL_SCRIPT =
  /^(https:\/\/[^\s"'<>]+|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?\/[^\s"'<>]*)$/;
// BCP 47 in its syntax: a language and any number of subtags of 1 to 8
// letters or digits (zh-Hant-TW, en-US-u-hc-h12, sr-Latn-RS).
const LANG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

type DevFrame = Readonly<{ script: string; lang?: string }>;

/** The DEV frame of this run: the shell script's address and the language,
 * or null where the run is not DEV (no `LAZURIO_RUNTIME_SHELL_SCRIPT`). */
function devFrameOf(
  options: DevFrameOptions,
  env: Environment,
): DevFrame | null {
  if (options.lang !== undefined && !LANG.test(options.lang))
    throw new ModuleKitError(
      "dev-frame-invalid",
      "lang must be a language tag",
    );
  const script = env[SHELL_SCRIPT_VARIABLE];
  if (script === undefined || script === "") return null;
  if (!SHELL_SCRIPT.test(script))
    throw new ModuleKitError(
      "dev-frame-invalid",
      `${SHELL_SCRIPT_VARIABLE} must be an https URL or an http URL on the loopback`,
    );
  return options.lang === undefined
    ? { script }
    : { script, lang: options.lang };
}

/** The two tags of the DEV frame: the one shape both plugins insert. */
function devFrameTags(frame: DevFrame): DevFrameTag[] {
  return [
    { tag: "script", attrs: { type: "module", src: frame.script } },
    {
      tag: "lazurio-buddy",
      attrs: {
        version: "dev",
        ...(frame.lang === undefined ? {} : { lang: frame.lang }),
      },
    },
  ];
}

// Elements whose content is text, never markup: a `</body>` or `<html` in
// them is not a tag (HTML's raw text and escapable raw text elements).
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

type HtmlTag = { name: string; end: boolean; start: number; stop: number };

/** The tags of a page as HTML reads them: each start or end tag's name and
 * where it begins and ends, skipping comments, doctypes and the content of
 * raw text elements. Enough to find `<html>` and `</body>`; no tree. */
function htmlTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  const lower = html.toLowerCase();
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[open + 1] === "!" || html[open + 1] === "?") {
      const close = html.indexOf(">", open);
      at = close === -1 ? html.length : close + 1;
      continue;
    }
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(
      html.slice(open, open + 64),
    );
    if (match === null) {
      at = open + 1;
      continue;
    }
    // The tag ends at the first `>` outside a quoted attribute value.
    let stop = open + match[0].length;
    let quote: string | null = null;
    while (stop < html.length) {
      const c = html[stop];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      stop += 1;
    }
    const name = (match[2] as string).toLowerCase();
    const end = match[1] === "/";
    tags.push({ name, end, start: open, stop: stop + 1 });
    at = stop + 1;
    if (!end && RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, at);
      at = close === -1 ? html.length : close;
    }
  }
  return tags;
}

/** `<html data-lazurio-shell="host">` on the page's real `<html>` start tag,
 * unless it says otherwise; a page without one is left as it is. */
function markShellHost(html: string): string {
  const tag = htmlTags(html).find((item) => item.name === "html" && !item.end);
  if (tag === undefined) return html;
  if (/\sdata-lazurio-shell\s*=/i.test(html.slice(tag.start, tag.stop)))
    return html;
  const at = tag.start + "<html".length;
  return `${html.slice(0, at)} data-lazurio-shell="host"${html.slice(at)}`;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Vite plugin: the DEV frame of a Module's app (decision 0249, addendum of
 * 2026-11-22: DEV has a blue dashed frame with the label DEV, drawn by the
 * overlay). It inserts only in a DEV run (`LAZURIO_RUNTIME_SHELL_SCRIPT`) and
 * only while serving; a build, STAGING and PROD get nothing, also from a
 * shared `vite.config.ts`. It inserts Lazurio's shell script and
 * `<lazurio-buddy version="dev">` at the end of `<body>`, and marks `<html>`
 * with `data-lazurio-shell="host"` so the shell does not read a shell
 * document the dev server does not have. The frame, its colour and its text
 * come only from the shell's element. A Module can leave the plugin out: it
 * frames, it does not enforce. Use in `vite.config.ts`:
 * `plugins: [react(), viteDevFramePlugin({ lang: "cs" })]`. */
export function viteDevFramePlugin(
  options: DevFrameOptions = {},
  env: Environment = process.env,
): {
  name: string;
  apply: "serve";
  transformIndexHtml: {
    order: "post";
    handler: (html: string) => string;
  };
} {
  devFrameOf(options, env);
  return {
    name: "lazurio-module-kit-dev-frame",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      // The page itself, not Vite's tags: Vite puts a body tag before the
      // first literal `</body>`, also one inside a script.
      handler: (html) => devFrameHtml(html, options, env),
    },
  };
}

/** The page with the DEV frame, as a string: what `bunDevFramePlugin`
 * serves. The tags go before the page's real `</body>` (never one inside a
 * script, a style, a comment or an attribute), or at the end of a page
 * without one. Not a DEV run: the page is unchanged. */
export function devFrameHtml(
  html: string,
  options: DevFrameOptions = {},
  env: Environment = process.env,
): string {
  const frame = devFrameOf(options, env);
  if (frame === null) return html;
  const tags = devFrameTags(frame)
    .map(({ tag, attrs }) => {
      const list = Object.entries(attrs)
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join("");
      return `<${tag}${list}></${tag}>`;
    })
    .join("");
  const marked = markShellHost(html);
  const body = htmlTags(marked)
    .filter((item) => item.name === "body" && item.end)
    .at(-1);
  return body === undefined
    ? `${marked}${tags}`
    : `${marked.slice(0, body.start)}${tags}${marked.slice(body.start)}`;
}

/** The subset of Bun's plugin builder the DEV frame needs. */
export interface DevFramePluginBuild {
  onLoad(
    constraints: { filter: RegExp },
    callback: (args: {
      path: string;
    }) => Promise<{ contents: string; loader: "html" }>,
  ): unknown;
}

/** Bun plugin: the same DEV frame for an App whose development run bundles
 * its page with Bun (`Bun.serve` with an HTML import, as the templates do).
 * Register it in the App's `bunfig.toml`: `[serve.static] plugins =
 * ["./dev-frame.ts"]`, where `dev-frame.ts` is `export default
 * bunDevFramePlugin({ lang: "cs" })`. It changes nothing outside a DEV run,
 * and a build served as files does not pass through it. */
export function bunDevFramePlugin(
  options: DevFrameOptions = {},
  env: Environment = process.env,
): {
  name: string;
  setup: (build: DevFramePluginBuild) => void;
} {
  devFrameOf(options, env);
  return {
    name: "lazurio-module-kit-dev-frame",
    setup(build) {
      build.onLoad({ filter: /\.html$/ }, async (args) => ({
        contents: devFrameHtml(await Bun.file(args.path).text(), options, env),
        loader: "html",
      }));
    },
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

/** A person the Environment's gateway admitted. */
export type AppPerson = Readonly<{
  /** The Lazurio account's subject, a lowercase UUID: stable for the
   * account, the key to remember a person by. */
  subject: string;
  /** The person's Lazurio username, to show; null when the gateway's answer
   * named none. */
  username: string | null;
}>;

/** Who came to this App and with which application role (decision 0231).
 * The stable contract of Lazurio for a Module: its fields and values never
 * change meaning or disappear, and new information comes as new fields.
 *
 * - `environment`: the person has the whole Environment where the App runs,
 *   so they are an Application Admin.
 * - `app`: the person has this App only, with the application role the
 *   Organization gave them.
 * - `local`: a request from inside the Environment (a person's own computer
 *   with no gateway, a sibling or a script on the Environment, or the
 *   Environment browser's local entry): an Application Admin without a name.
 * - `unknown`: a request that came through the gateway without identity
 *   (a gateway without this capability): no application role at all.
 *
 * `appRole` carries the application role of decision 0234 as a stable value:
 * `"admin"` is the Application Admin and `"user"` the Application User. What
 * an Application Admin and an Application User may do is the Organization's
 * rule in the Module's code, enforced on the server for every request. The
 * answer is no key to data and signs nothing. */
export type AppAccess =
  | Readonly<{
      entry: "environment";
      appRole: "admin";
      person: AppPerson;
      /** Who states it: the Environment's gateway, or later an identity
       * signed by Lazurio Auth for use outside the Environment. */
      source: "gateway" | "auth";
      reason: null;
    }>
  | Readonly<{
      entry: "app";
      appRole: "admin" | "user";
      person: AppPerson;
      source: "gateway" | "auth";
      reason: null;
    }>
  | Readonly<{
      entry: "local";
      appRole: "admin";
      person: null;
      /** No person was stated, so nobody stated it. */
      source: null;
      reason: "not-hosted" | "not-through-gateway" | "local-entry";
    }>
  | Readonly<{
      entry: "unknown";
      appRole: null;
      person: null;
      source: null;
      reason: "no-identity";
    }>;

/** What `appAccess` reads of a request: a `Request` or its headers. */
export type RequestHeaders = Readonly<{ get(name: string): string | null }>;

/** How the Environment's gateway carries its statement to the App. Internal
 * transport, not a contract: only `appAccess` reads it, and it may change
 * without changing `appAccess`. Exported for a Module's own tests. */
export const GATEWAY_HEADERS = Object.freeze({
  subject: "x-auth-request-user",
  username: "x-auth-request-preferred-username",
  entry: "x-lazurio-entry",
  appRole: "x-lazurio-app-role",
});

const SUBJECT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY_CASE = new RegExp(SUBJECT.source, "i");

/** A Lazurio username: 3 to 39 lowercase letters and digits with single
 * dashes between them, never shaped like a UUID and never a service
 * account's (`service-account-…`). */
export function isLazurioUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 39 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
    !UUID_ANY_CASE.test(value) &&
    !value.startsWith("service-account-")
  );
}

/** The hostname a `Host` header names, lowercased, without a port and a
 * trailing dot, as the gateway matches it; null when it names none. */
function hostnameOf(host: string | null): string | null {
  if (host === null) return null;
  const match = /^(\[[^\]]*\]|[^:[\]]*)(?::[0-9]*)?$/.exec(host.trim());
  const name = match?.[1]?.toLowerCase().replace(/\.$/, "") ?? "";
  return name === "" ? null : name;
}

const LOOPBACK_HOST = /^(?:127(?:\.[0-9]{1,3}){3}|localhost|\[::1\])$/;

/** Who came to this App and with which application role, for one request
 * (decision 0231; Lazurio Module Standard, "Who came and with which role").
 *
 * The answer has the same five fields in every case. Without an external
 * origin (`LAZURIO_RUNTIME_LISTENER_<ID>_EXTERNAL_ORIGIN`) no gateway stands
 * in front of the App and every request is `local`. With one, a request whose
 * `Host` names the external origin's hostname, in any letter case and with
 * any port, as the gateway matches it, counts only by the gateway's statement:
 * a missing, repeated or malformed statement is `unknown`, never a role. A
 * request to a loopback address (a sibling, a script, an agent) is `local`;
 * any other `Host` is `unknown`. The gateway removes every client copy and
 * admits every request again, so read it per request and never cache it.
 * Inside the Environment the answer holds as far as the Environment does: a
 * process on it that reaches the App's loopback port could send anything, as
 * it could read the App's data (decision 0196), so it is no authentication
 * boundary inside the Environment. Throws `listener-missing` like
 * `listener(id)`. */
export function appAccess(
  request: Request | RequestHeaders,
  id = "app",
  env: Environment = process.env,
): AppAccess {
  const { externalOrigin } = listener(id, env);
  const local = (
    reason: "not-hosted" | "not-through-gateway" | "local-entry",
  ): AppAccess => ({
    entry: "local",
    appRole: "admin",
    person: null,
    source: null,
    reason,
  });
  const unknown: AppAccess = {
    entry: "unknown",
    appRole: null,
    person: null,
    source: null,
    reason: "no-identity",
  };
  if (externalOrigin === null) return local("not-hosted");
  const headers: RequestHeaders =
    "headers" in request ? request.headers : request;
  const host = hostnameOf(headers.get("host"));
  if (host !== hostnameOf(new URL(externalOrigin).host))
    return host !== null && LOOPBACK_HOST.test(host)
      ? local("not-through-gateway")
      : unknown;
  // Through the gateway: only its statement counts. A repeated header reads
  // as its values joined with a comma, so it never matches one valid value.
  const entry = headers.get(GATEWAY_HEADERS.entry);
  const subject = headers.get(GATEWAY_HEADERS.subject);
  if (
    entry === "local" &&
    subject === null &&
    headers.get(GATEWAY_HEADERS.username) === null &&
    headers.get(GATEWAY_HEADERS.appRole) === null
  )
    return local("local-entry");
  if (subject === null || !SUBJECT.test(subject)) return unknown;
  const username = headers.get(GATEWAY_HEADERS.username);
  const person: AppPerson = {
    subject,
    username: isLazurioUsername(username) ? username : null,
  };
  if (entry === "environment")
    return {
      entry: "environment",
      appRole: "admin",
      person,
      source: "gateway",
      reason: null,
    };
  if (entry === "app") {
    const appRole = headers.get(GATEWAY_HEADERS.appRole);
    if (appRole === "admin" || appRole === "user")
      return { entry: "app", appRole, person, source: "gateway", reason: null };
  }
  return unknown;
}
