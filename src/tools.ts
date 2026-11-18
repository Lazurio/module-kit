/**
 * One tool contract for agents (Lazurio Module Standard, "Agents in the App").
 *
 * A Module defines its tools once, on its server, and offers them through two
 * transports over the same handler:
 *
 * - `/mcp`: a stateless MCP server (Streamable HTTP, JSON responses, POST
 *   only) behind the Application host's gateway, which admits a Lazurio Auth
 *   Bearer token with the application's role;
 * - the page: a manifest and a call endpoint that the App's own page uses to
 *   register the same tools as WebMCP tools (`@lazurio/module-kit/webmcp`),
 *   called with the page's own session.
 *
 * Both read who came only through `appAccess`, list only the tools the role
 * and the writer mode allow, and refuse with the same codes. A tool calls the
 * Module's domain service, never the data files or SQL directly, so the data
 * layer (repository-db in `app/v3`, Dolt in `app/v4`) changes under the tools
 * without changing them.
 */
import { type AppAccess, appAccess, listener } from "./index.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** The MCP protocol revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

/** The refusal codes every App answers with, on `/mcp`, on the page and in
 * its own HTTP API. A Module may add domain refusals of its own
 * (`snake_case`, for example `document_number_taken`). */
export const REFUSAL_CODES = [
  "identity_unavailable",
  "forbidden",
  "unknown_tool",
  "invalid_input",
  "not_found",
  "record_changed",
  "data_read_only",
  "unavailable",
  "internal_error",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** What a tool does to the App's data:
 * - `read`: changes nothing (finding, reading, computing, producing a file
 *   such as a PDF); offered in the read-only mode as well;
 * - `prepare`: changes no shared data and prepares a step the person
 *   completes in the interface (an approval, a signature, a sending);
 * - `write`: changes data. `publishesData` says whether the change is a
 *   publication of data (a commit and push in repository-db, `DOLT_COMMIT` in
 *   a database) or only a draft. */
export type ToolEffect = "read" | "prepare" | "write";

/** The application role a tool needs at least. */
export type ToolRole = "user" | "admin";

/** Where the call came from, recorded with the change and in the audit. */
export type ToolChannel = "mcp" | "webmcp";

/** Where the App runs: an Organization's production application on an
 * Application host, or a Module version in an Environment. */
export type Deployment = "production" | "environment";

/** A JSON Schema object, as MCP and WebMCP carry it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The Standard Schema interface (https://standardschema.dev), which zod,
 * valibot and others implement; module-kit depends on none of them. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}
type StandardIssue = {
  readonly message: string;
  readonly path?:
    | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
    | undefined;
};
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/** An application role that came: never `unknown`. */
export type KnownAccess = Exclude<AppAccess, { entry: "unknown" }>;

/** What a tool's handler gets besides its input. */
export interface ToolContext {
  readonly access: KnownAccess;
  readonly channel: ToolChannel;
  readonly deployment: Deployment;
  /** Whether this App may change data now (`dataWriter`). */
  readonly canWrite: boolean;
  readonly request: Request;
}

/** A file a tool produced, such as a PDF. */
export interface ToolFile {
  readonly name: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** A refusal: the reason code, a sentence for the agent and, for
 * `record_changed`, the record's current revision. */
export interface ToolRefusal {
  readonly ok: false;
  readonly reason: RefusalCode | (string & {});
  readonly message: string;
  readonly current_revision?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** What a tool returns: JSON data (an object) and optional files, or a
 * refusal. A tool never throws for an expected outcome. */
export type ToolResult<Data extends object = Record<string, unknown>> =
  | {
      readonly ok: true;
      readonly data: Data;
      readonly files?: readonly ToolFile[];
    }
  | ToolRefusal;

interface ToolDefinitionBase<Input> {
  /** `snake_case`, verb first, in English: `find_revisions`. */
  readonly name: string;
  readonly title?: string;
  /** In the Organization's language: what the tool does and returns. */
  readonly description: string;
  /** Validates and types the input (zod, valibot…). */
  readonly input: StandardSchemaV1<unknown, Input>;
  /** The same input as JSON Schema, as agents see it. */
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly minRole: ToolRole;
  /** Calling it twice with the same input changes nothing more. */
  readonly idempotent?: boolean;
  /** Its answer carries text people or other systems wrote; the agent
   * treats it as data, never as instructions. */
  readonly untrustedContent?: boolean;
  readonly run: (
    input: Input,
    context: ToolContext,
  ) => Promise<ToolResult<object>> | ToolResult<object>;
}

/** One tool of the App. */
export type ToolDefinition<Input = unknown> = ToolDefinitionBase<Input> &
  (
    | {
        readonly effect: "read" | "prepare";
        readonly publishesData?: never;
        readonly publicationConsent?: never;
      }
    | {
        readonly effect: "write";
        readonly publishesData: boolean;
        /** For a write that publishes data in a production application: where
         * the Owner decided in advance that agents publish this kind of record
         * (a plan or decision reference). That is the person's prior consent
         * to the Publication; without it the tool is not offered there. */
        readonly publicationConsent?: string;
      }
  );

/** Types a tool from its input schema. */
export function defineTool<Input>(
  tool: ToolDefinition<Input>,
): ToolDefinition<Input> {
  return tool;
}

/** What an agent sees of a tool, on `/mcp` and on the page. */
export interface ToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly effect: ToolEffect;
  readonly annotations: {
    readonly title?: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
    readonly untrustedContentHint: boolean;
  };
}

/** The App this registry serves, as `get_app_context` reports it. */
export interface AppInfo {
  /** The Module's slug. */
  readonly module: string;
  /** The App's released version (its `package.json` version). */
  readonly version: string;
  /** The App generation, which names its data layer. */
  readonly dataGeneration: "v1" | "v2" | "v3" | "v4";
  readonly title?: string;
  /** Rules of the domain the agent should know, in the Organization's
   * language (MCP `instructions`). */
  readonly instructions?: string;
}

/** One line of the audit: who called which tool and how it ended, never
 * the input or the answer. */
export interface ToolAuditEvent {
  readonly event: "agent-tool";
  readonly channel: ToolChannel;
  readonly tool: string;
  readonly entry: AppAccess["entry"];
  readonly subject: string | null;
  readonly appRole: AppAccess["appRole"];
  readonly outcome: "ok" | RefusalCode | (string & {});
  readonly durationMs: number;
}

export interface ToolRegistryOptions {
  readonly app: AppInfo;
  // biome-ignore lint/suspicious/noExplicitAny: each tool types its own input
  readonly tools: readonly ToolDefinition<any>[];
  /** The listener `appAccess` reads (default `app`). */
  readonly listener?: string;
  readonly env?: Environment;
  /** The page endpoints' path (default `/api/agent-tools`). */
  readonly pagePath?: string;
  /** The MCP endpoint's path (default `/mcp`), which `effectOf` classifies
   * as MCP. */
  readonly mcpPath?: string;
  /** Upper bound of a request body (default 64 KiB). */
  readonly maxBodyBytes?: number;
  /** Upper bound of the files of one answer (default 10 MiB). */
  readonly maxFileBytes?: number;
  /** Receives every call; the default writes one JSON line to stdout. */
  readonly audit?: (event: ToolAuditEvent) => void;
}

export interface ToolRegistry {
  /** Answers `/mcp`. */
  handleMcp(request: Request): Promise<Response>;
  /** Answers the page endpoints, or `null` for any other path. */
  handlePage(request: Request): Promise<Response | null>;
  /** The tools this access may see now. */
  list(access: AppAccess): readonly ToolDescriptor[];
  /** What a request to `/mcp` or to the page endpoints does to the data,
   * read from a copy of the request, so a data layer that decides by the
   * HTTP method (every tool call is a `POST`) can decide by the tool:
   * `tools/call` and a page call give the named tool's effect, every other
   * MCP method and the manifest are `read`, and `null` means not a tool
   * request, an unknown tool or an unreadable body (treat it as a write). */
  effectOf(request: Request): Promise<ToolEffect | null>;
}

const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Whether this App may change data now. `LAZURIO_RUNTIME_DATA_WRITER=true`
 * writes and any other value does not. Without it, a runtime that states
 * `LAZURIO_RUNTIME_DEPLOYMENT=production` never writes (Lazurio/module-kit#9);
 * otherwise (a development version in an Environment) only a local or
 * Environment entry writes, to the Environment's own data. */
export function dataWriter(
  access: AppAccess,
  env: Environment = process.env,
): boolean {
  const value = env.LAZURIO_RUNTIME_DATA_WRITER;
  if (value !== undefined) return value === "true";
  if (env.LAZURIO_RUNTIME_DEPLOYMENT === "production") return false;
  return access.entry === "local" || access.entry === "environment";
}

/** Where the App runs. Until the runtime states it explicitly
 * (Lazurio/LazurioPlatform#1041), an App on an Application host is the one
 * whose runtime sets `LAZURIO_RUNTIME_DATA_WRITER`. */
export function deployment(env: Environment = process.env): Deployment {
  const stated = env.LAZURIO_RUNTIME_DEPLOYMENT;
  if (stated === "production" || stated === "environment") return stated;
  return env.LAZURIO_RUNTIME_DATA_WRITER === undefined
    ? "environment"
    : "production";
}

const EMPTY_INPUT: StandardSchemaV1<unknown, Record<string, never>> = {
  "~standard": {
    version: 1,
    vendor: "lazurio",
    validate: (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
        ? { value: {} }
        : { issues: [{ message: "The tool takes no input." }] },
  },
};

function appContextTool(app: AppInfo): ToolDefinition<Record<string, never>> {
  return {
    name: "get_app_context",
    title: "App context",
    description:
      "Which App this is and how you work with it now: module, version, data generation, production application or a Module version in an Environment, your entry and application role, whether you may change data.",
    input: EMPTY_INPUT,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    minRole: "user",
    effect: "read",
    idempotent: true,
    run: (_input, context) => ({
      ok: true,
      data: {
        module: app.module,
        app_version: app.version,
        data_generation: app.dataGeneration,
        deployment: context.deployment,
        entry: context.access.entry,
        app_role: context.access.appRole,
        person: context.access.person,
        can_write: context.canWrite,
        channel: context.channel,
      },
    }),
  };
}

function descriptor(tool: ToolDefinition<unknown>): ToolDescriptor {
  const readOnly = tool.effect !== "write";
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
    effect: tool.effect,
    annotations: {
      ...(tool.title === undefined ? {} : { title: tool.title }),
      readOnlyHint: readOnly,
      destructiveHint: tool.effect === "write" && tool.publishesData === true,
      idempotentHint: tool.idempotent ?? readOnly,
      openWorldHint: false,
      untrustedContentHint: tool.untrustedContent === true,
    },
  };
}

function refusal(
  reason: ToolRefusal["reason"],
  message: string,
  extra: Partial<Pick<ToolRefusal, "current_revision" | "details">> = {},
): ToolRefusal {
  return { ok: false, reason, message, ...extra };
}

const HTTP_STATUS: Readonly<Record<string, number>> = {
  identity_unavailable: 403,
  forbidden: 403,
  data_read_only: 403,
  unknown_tool: 404,
  not_found: 404,
  invalid_input: 422,
  record_changed: 409,
  unavailable: 503,
  internal_error: 500,
};

function json(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function base64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000)
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A tool name from a page path segment, or null when it is not one (a
 * malformed percent escape, a slash). */
function toolNameOf(segment: string): string | null {
  try {
    const name = decodeURIComponent(segment);
    return TOOL_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Whether the body is declared as JSON (`application/json`, any
 * parameters). */
function isJson(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

class BodyTooLarge extends Error {}

async function readBody(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) throw new BodyTooLarge();
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function issuesOf(issues: ReadonlyArray<StandardIssue>) {
  return issues.map((issue) => ({
    message: issue.message,
    path: (issue.path ?? []).map((part) =>
      typeof part === "object" ? String(part.key) : String(part),
    ),
  }));
}

/** Builds the App's tool registry: its tools plus `get_app_context`. */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const env = options.env ?? process.env;
  const listenerId = options.listener ?? "app";
  const pagePath = (options.pagePath ?? "/api/agent-tools").replace(/\/$/, "");
  const mcpPath = (options.mcpPath ?? "/mcp").replace(/\/$/, "");
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const maxFiles = options.maxFileBytes ?? 10 * 1024 * 1024;
  const audit =
    options.audit ??
    ((event: ToolAuditEvent) => console.log(JSON.stringify(event)));
  const tools = new Map<string, ToolDefinition<unknown>>();
  for (const tool of [appContextTool(options.app), ...options.tools]) {
    if (!TOOL_NAME.test(tool.name))
      throw new TypeError(`Tool name is not snake_case: ${tool.name}`);
    if (tools.has(tool.name))
      throw new TypeError(`Tool defined twice: ${tool.name}`);
    tools.set(tool.name, tool as ToolDefinition<unknown>);
  }
  const own = listener(listenerId, env);
  /** The origins this App itself is served from: its external origin behind
   * a gateway, else its own loopback listener (scheme, host and port). */
  const ownOrigins: ReadonlySet<string> = new Set(
    own.externalOrigin !== null
      ? [new URL(own.externalOrigin).origin]
      : ["127.0.0.1", "localhost", "[::1]"].map(
          (host) => `http://${host}:${own.port}`,
        ),
  );

  /** Whether an `Origin` is exactly one of this App's own origins; anything
   * else, including another port on the same computer, is refused. */
  const originAllowed = (origin: string): boolean => {
    try {
      const parsed = new URL(origin);
      return parsed.origin === origin && ownOrigins.has(origin);
    } catch {
      return false;
    }
  };

  /** Why this access may not call this tool now, or null. */
  const barrier = (
    tool: ToolDefinition<unknown>,
    access: KnownAccess,
    canWrite: boolean,
    where: Deployment,
  ): ToolRefusal | null => {
    if (tool.minRole === "admin" && access.appRole !== "admin")
      return refusal(
        "forbidden",
        `${tool.name} needs the Application Admin role.`,
      );
    if (tool.effect !== "write") return null;
    if (!canWrite)
      return refusal(
        "data_read_only",
        "This App does not change data now (read-only mode).",
      );
    if (
      tool.publishesData === true &&
      where === "production" &&
      (tool.publicationConsent ?? "").trim() === ""
    )
      return refusal(
        "forbidden",
        `${tool.name} would publish data; in a production application a person publishes in the interface.`,
      );
    return null;
  };

  const known = (access: AppAccess): access is KnownAccess =>
    access.entry !== "unknown";

  const list = (access: AppAccess): readonly ToolDescriptor[] => {
    if (!known(access)) return [];
    const canWrite = dataWriter(access, env);
    const where = deployment(env);
    return [...tools.values()]
      .filter((tool) => barrier(tool, access, canWrite, where) === null)
      .map(descriptor);
  };

  const call = async (
    name: string,
    raw: unknown,
    access: KnownAccess,
    channel: ToolChannel,
    request: Request,
  ): Promise<ToolResult<object>> => {
    const started = performance.now();
    const finish = (result: ToolResult<object>) => {
      audit({
        event: "agent-tool",
        channel,
        tool: tools.has(name) ? name : "(unknown)",
        entry: access.entry,
        subject: access.person?.subject ?? null,
        appRole: access.appRole,
        outcome: result.ok ? "ok" : result.reason,
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    };
    const tool = tools.get(name);
    if (tool === undefined)
      return finish(refusal("unknown_tool", "This App has no such tool."));
    const canWrite = dataWriter(access, env);
    const where = deployment(env);
    const blocked = barrier(tool, access, canWrite, where);
    if (blocked !== null) return finish(blocked);
    let parsed: Awaited<
      ReturnType<(typeof tool.input)["~standard"]["validate"]>
    >;
    try {
      parsed = await tool.input["~standard"].validate(raw ?? {});
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "agent-tool-error",
          tool: name,
          stage: "input",
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      return finish(refusal("internal_error", "The tool failed."));
    }
    if (parsed.issues !== undefined)
      return finish(
        refusal("invalid_input", "The input does not match the tool.", {
          details: { issues: issuesOf(parsed.issues) },
        }),
      );
    try {
      const result = await tool.run(parsed.value, {
        access,
        channel,
        deployment: where,
        canWrite,
        request,
      });
      if (result.ok) {
        const size = (result.files ?? []).reduce(
          (sum, file) => sum + file.data.byteLength,
          0,
        );
        if (size > maxFiles)
          return finish(
            refusal("unavailable", "The produced files are too large."),
          );
      }
      return finish(result);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "agent-tool-error",
          tool: name,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      return finish(refusal("internal_error", "The tool failed."));
    }
  };

  const mcpResult = (result: ToolResult<object>) => {
    if (!result.ok)
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: true,
      };
    const files = (result.files ?? []).map((file) => ({
      type: "resource",
      resource: {
        uri: `urn:lazurio:${options.app.module}:file:${encodeURIComponent(file.name)}`,
        mimeType: file.mimeType,
        blob: base64(file.data),
      },
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(result.data) }, ...files],
      structuredContent: result.data,
      isError: false,
    };
  };

  const rpcError = (id: unknown, code: number, message: string, status = 200) =>
    json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

  const handleMcp = async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    const origin = request.headers.get("origin");
    if (origin !== null && !originAllowed(origin))
      return json({ error: "origin_not_allowed" }, 403);
    const access = appAccess(request, listenerId, env);
    if (!known(access)) return json({ error: "identity_unavailable" }, 403);
    const version = request.headers.get("mcp-protocol-version");
    if (
      version !== null &&
      !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)
    )
      return rpcError(null, -32600, "Unsupported MCP protocol version.", 400);
    if (!isJson(request)) return json({ error: "unsupported_media_type" }, 415);
    let text: string;
    try {
      text = await readBody(request, maxBody);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return json({ error: "body_too_large" }, 413);
      throw error;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return rpcError(null, -32700, "Parse error.", 400);
    }
    if (Array.isArray(message))
      return rpcError(null, -32600, "Batches are not supported.", 400);
    if (
      message === null ||
      typeof message !== "object" ||
      (message as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
      typeof (message as { method?: unknown }).method !== "string"
    ) {
      // A response or a malformed message: nothing to answer.
      if (message !== null && typeof message === "object" && "id" in message)
        return new Response(null, { status: 202 });
      return rpcError(null, -32600, "Invalid request.", 400);
    }
    const { id, method, params } = message as {
      id?: unknown;
      method: string;
      params?: Record<string, unknown>;
    };
    if (id === undefined) return new Response(null, { status: 202 });
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        const protocolVersion = (
          MCP_PROTOCOL_VERSIONS as readonly unknown[]
        ).includes(asked)
          ? (asked as string)
          : MCP_PROTOCOL_VERSIONS[0];
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: options.app.module,
              ...(options.app.title === undefined
                ? {}
                : { title: options.app.title }),
              version: options.app.version,
            },
            ...(options.app.instructions === undefined
              ? {}
              : { instructions: options.app.instructions }),
          },
        });
      }
      case "ping":
        return json({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: list(access).map(
              ({
                effect: _effect,
                annotations: { untrustedContentHint: _hint, ...annotations },
                ...tool
              }) => ({ ...tool, annotations }),
            ),
          },
        });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string")
          return rpcError(id, -32602, "tools/call needs a tool name.");
        const result = await call(
          name,
          params?.arguments,
          access,
          "mcp",
          request,
        );
        return json({ jsonrpc: "2.0", id, result: mcpResult(result) });
      }
      default:
        return rpcError(id, -32601, "Method not found.");
    }
  };

  const handlePage = async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const isManifest = path === pagePath;
    const isCall = path.startsWith(`${pagePath}/`);
    if (!isManifest && !isCall) return null;
    const access = appAccess(request, listenerId, env);
    if (isManifest) {
      if (request.method !== "GET")
        return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
      if (!known(access))
        return json(
          refusal("identity_unavailable", "Lazurio did not say who came."),
          403,
        );
      return json({
        app: {
          module: options.app.module,
          version: options.app.version,
          data_generation: options.app.dataGeneration,
        },
        tools: list(access),
      });
    }
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    // The page calls with its own session: only its own origin may.
    const origin = request.headers.get("origin");
    if (origin === null || !originAllowed(origin))
      return json({ error: "origin_not_allowed" }, 403);
    // A cross-site page could send a simple `text/plain` POST without a
    // preflight; the page sends JSON.
    if (!isJson(request)) return json({ error: "unsupported_media_type" }, 415);
    if (!known(access))
      return json(
        refusal("identity_unavailable", "Lazurio did not say who came."),
        403,
      );
    const name = toolNameOf(path.slice(pagePath.length + 1));
    if (name === null)
      return json(refusal("unknown_tool", "This App has no such tool."), 404);
    let raw: unknown;
    try {
      const text = await readBody(request, maxBody);
      raw = text === "" ? {} : JSON.parse(text);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return json({ error: "body_too_large" }, 413);
      return json(refusal("invalid_input", "The input is not JSON."), 422);
    }
    const result = await call(name, raw, access, "webmcp", request);
    if (!result.ok) return json(result, HTTP_STATUS[result.reason] ?? 409);
    return json({
      ok: true,
      data: result.data,
      ...(result.files === undefined
        ? {}
        : {
            files: result.files.map((file) => ({
              name: file.name,
              mimeType: file.mimeType,
              base64: base64(file.data),
            })),
          }),
    });
  };

  const effectOf = async (request: Request): Promise<ToolEffect | null> => {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    if (path === pagePath) return "read";
    if (path.startsWith(`${pagePath}/`)) {
      if (request.method !== "POST") return "read";
      const name = toolNameOf(path.slice(pagePath.length + 1));
      return name === null ? null : (tools.get(name)?.effect ?? null);
    }
    // Only the MCP endpoint is MCP; any other path is not a tool request.
    if (path !== mcpPath) return null;
    if (request.method !== "POST") return "read";
    let message: unknown;
    try {
      message = JSON.parse(await readBody(request.clone(), maxBody));
    } catch {
      return null;
    }
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    )
      return null;
    const { method, params } = message as {
      method?: unknown;
      params?: { name?: unknown };
    };
    if (method !== "tools/call") return "read";
    return typeof params?.name === "string"
      ? (tools.get(params.name)?.effect ?? null)
      : null;
  };

  return { handleMcp, handlePage, list, effectOf };
}
