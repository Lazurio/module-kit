/**
 * Test helpers for a Module's tools: requests as the Application host's
 * gateway states them, MCP calls and page calls. For tests only; the gateway
 * removes every client copy of these headers in production.
 */
import { GATEWAY_HEADERS } from "./index.ts";
import type { ToolRegistry } from "./tools.ts";

/** The external origin the helpers use unless told otherwise. */
export const TEST_ORIGIN = "https://app.example-org.lazurio.app";

/** A runtime environment of an App on an Application host. */
export function hostedEnvironment(
  options: {
    readonly origin?: string;
    readonly writer?: boolean;
    readonly listener?: string;
    readonly extra?: Readonly<Record<string, string>>;
  } = {},
): Record<string, string> {
  const key = (options.listener ?? "app")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
  return {
    [`LAZURIO_RUNTIME_LISTENER_${key}_HOST`]: "127.0.0.1",
    [`LAZURIO_RUNTIME_LISTENER_${key}_PORT`]: "43100",
    [`LAZURIO_RUNTIME_LISTENER_${key}_EXTERNAL_ORIGIN`]:
      options.origin ?? TEST_ORIGIN,
    LAZURIO_RUNTIME_DATA_WRITER: options.writer === true ? "true" : "false",
    ...options.extra,
  };
}

/** A runtime environment of a Module version in an Environment: no gateway,
 * no writer flag. */
export function localEnvironment(listener = "app"): Record<string, string> {
  const key = listener.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    [`LAZURIO_RUNTIME_LISTENER_${key}_HOST`]: "127.0.0.1",
    [`LAZURIO_RUNTIME_LISTENER_${key}_PORT`]: "43100",
  };
}

/** Who the gateway states: an Application User or Admin, a person with the
 * whole Environment, or nobody (`none`, as an older gateway would). */
export type GatewayCaller =
  | { readonly role: "user" | "admin"; readonly subject?: string }
  | { readonly role: "environment"; readonly subject?: string }
  | { readonly role: "none" };

export const TEST_SUBJECT = "2659b76d-0000-4000-8000-000000000001";

/** A request through the gateway to the App's external origin. */
export function gatewayRequest(
  path: string,
  options: {
    readonly caller?: GatewayCaller;
    readonly method?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly appOrigin?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Request {
  const appOrigin = options.appOrigin ?? TEST_ORIGIN;
  const caller = options.caller ?? { role: "user" };
  const headers: Record<string, string> = {
    host: new URL(appOrigin).host,
    ...options.headers,
  };
  if (options.body !== undefined)
    headers["content-type"] ??= "application/json";
  if (options.origin !== undefined && options.origin !== null)
    headers.origin = options.origin;
  if (caller.role !== "none") {
    headers[GATEWAY_HEADERS.subject] = caller.subject ?? TEST_SUBJECT;
    headers[GATEWAY_HEADERS.username] = "test-person";
    if (caller.role === "environment")
      headers[GATEWAY_HEADERS.entry] = "environment";
    else {
      headers[GATEWAY_HEADERS.entry] = "app";
      headers[GATEWAY_HEADERS.appRole] = caller.role;
    }
  }
  return new Request(new URL(path, appOrigin), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.body === undefined
      ? {}
      : {
          body:
            typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
        }),
  });
}

let nextId = 1;

/** Sends one JSON-RPC request to `/mcp` and returns the HTTP status and the
 * parsed answer. */
export async function mcpCall(
  registry: ToolRegistry,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    readonly caller?: GatewayCaller;
    readonly appOrigin?: string;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await registry.handleMcp(
    gatewayRequest("/mcp", {
      ...options,
      body: { jsonrpc: "2.0", id: nextId++, method, params },
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The names `tools/list` returns for a caller. */
export async function mcpToolNames(
  registry: ToolRegistry,
  caller: GatewayCaller,
  appOrigin?: string,
): Promise<string[]> {
  const { body } = await mcpCall(
    registry,
    "tools/list",
    {},
    { caller, ...(appOrigin === undefined ? {} : { appOrigin }) },
  );
  const result = body.result as { tools?: Array<{ name: string }> } | undefined;
  return (result?.tools ?? []).map((tool) => tool.name).sort();
}

/** The tools `tools/list` returns for a caller, with their annotations, so
 * a Module checks that every publication carries `destructiveHint`. */
export async function mcpTools(
  registry: ToolRegistry,
  caller: GatewayCaller,
  appOrigin?: string,
): Promise<Array<{ name: string; annotations: Record<string, unknown> }>> {
  const { body } = await mcpCall(
    registry,
    "tools/list",
    {},
    { caller, ...(appOrigin === undefined ? {} : { appOrigin }) },
  );
  const result = body.result as
    | {
        tools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
      }
    | undefined;
  return (result?.tools ?? [])
    .map((tool) => ({ name: tool.name, annotations: tool.annotations ?? {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Calls a tool through `/mcp` and returns its structured answer. */
export async function mcpTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  caller: GatewayCaller = { role: "user" },
  appOrigin?: string,
): Promise<{ isError: boolean; structured: Record<string, unknown> }> {
  const { body } = await mcpCall(
    registry,
    "tools/call",
    { name, arguments: input },
    { caller, ...(appOrigin === undefined ? {} : { appOrigin }) },
  );
  const result = body.result as
    | { isError: boolean; structuredContent: Record<string, unknown> }
    | undefined;
  if (result === undefined)
    throw new Error(`No tool result: ${JSON.stringify(body)}`);
  return { isError: result.isError, structured: result.structuredContent };
}

/** Calls a tool as the page does and returns the status and answer. */
export async function pageTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  caller: GatewayCaller = { role: "user" },
  appOrigin: string = TEST_ORIGIN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await registry.handlePage(
    gatewayRequest(`/api/agent-tools/${name}`, {
      caller,
      appOrigin,
      origin: appOrigin,
      body: input,
    }),
  );
  if (response === null) throw new Error("The page endpoint did not answer.");
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
