/**
 * The page side of the one tool contract (Lazurio Module Standard, "Agents
 * in the App"): registers the App's server tools as WebMCP tools, so an agent
 * that has the App open in the Environment browser (the right panel) calls
 * them directly, with the page's own session.
 *
 * The page asks its server which tools the person may use now (already
 * filtered by role and writer mode) and registers exactly those; each call
 * goes to the same server handler as `/mcp`. A page may add view tools of its
 * own (opening a record, showing a view) that never change data. Without the
 * WebMCP API (`document.modelContext`, `navigator.modelContext`) nothing is
 * registered and the page works the same.
 */
import type { ToolDescriptor } from "./tools.ts";

/** A WebMCP tool as the page registers it. */
export interface WebMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly untrustedContentHint?: boolean;
  };
  readonly execute: (input: unknown) => Promise<unknown>;
}

/** The part of the WebMCP API this helper uses. */
export interface ModelContextLike {
  registerTool(
    tool: WebMcpTool,
    options?: { readonly signal?: AbortSignal },
  ): unknown;
}

/** A view tool of the page: it opens or shows something and never changes
 * data. Its answer is JSON for the agent; a refusal is `{ ok: false, reason,
 * message }`, never a thrown error. */
export interface PageViewTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly execute: (input: unknown) => Promise<unknown> | unknown;
}

export interface RegisterAgentToolsOptions {
  /** The page endpoints of the server registry (default `/api/agent-tools`). */
  readonly endpoint?: string;
  readonly viewTools?: readonly PageViewTool[];
  readonly modelContext?: ModelContextLike | null;
  readonly fetch?: typeof fetch;
}

export interface AgentTools {
  /** The names registered now. */
  readonly registered: readonly string[];
  /** Asks the server again (after a sign-in, a role or writer change). */
  refresh(): Promise<readonly string[]>;
  /** Removes every tool this helper registered. */
  unregister(): void;
}

function findModelContext(): ModelContextLike | null {
  const scope = globalThis as {
    document?: { modelContext?: ModelContextLike };
    navigator?: { modelContext?: ModelContextLike };
  };
  return scope.document?.modelContext ?? scope.navigator?.modelContext ?? null;
}

async function answer(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {
      ok: false,
      reason: "unavailable",
      message: `The App answered HTTP ${response.status}.`,
    };
  }
}

/** Registers the App's tools for agents on this page. */
export async function registerAgentTools(
  options: RegisterAgentToolsOptions = {},
): Promise<AgentTools> {
  const context =
    options.modelContext === undefined
      ? findModelContext()
      : options.modelContext;
  const endpoint = (options.endpoint ?? "/api/agent-tools").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  let controllers: Array<{ abort(): void }> = [];
  let registered: string[] = [];

  const unregister = () => {
    for (const controller of controllers) controller.abort();
    controllers = [];
    registered = [];
  };

  const register = (tool: WebMcpTool) => {
    if (context === null) return;
    const controller = new AbortController();
    const handle = context.registerTool(tool, { signal: controller.signal });
    const legacy = handle as { unregister?: () => void } | undefined;
    controllers.push({
      abort: () => {
        controller.abort();
        legacy?.unregister?.();
      },
    });
    registered.push(tool.name);
  };

  const refresh = async (): Promise<readonly string[]> => {
    unregister();
    if (context === null) return registered;
    let tools: readonly ToolDescriptor[] = [];
    try {
      const response = await doFetch(endpoint, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (response.ok)
        tools =
          ((await response.json()) as { tools?: ToolDescriptor[] }).tools ?? [];
    } catch {
      tools = [];
    }
    const serverNames = new Set(tools.map((tool) => tool.name));
    for (const tool of tools)
      register({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.annotations.readOnlyHint,
          untrustedContentHint: tool.annotations.untrustedContentHint,
        },
        execute: async (input) =>
          answer(
            await doFetch(`${endpoint}/${encodeURIComponent(tool.name)}`, {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify(input ?? {}),
            }),
          ),
      });
    for (const view of options.viewTools ?? []) {
      // A view tool never shadows a server tool.
      if (serverNames.has(view.name)) continue;
      register({
        name: view.name,
        ...(view.title === undefined ? {} : { title: view.title }),
        description: view.description,
        inputSchema: view.inputSchema,
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          try {
            return await view.execute(input);
          } catch {
            return {
              ok: false,
              reason: "internal_error",
              message: "The view tool failed.",
            };
          }
        },
      });
    }
    return registered;
  };

  await refresh();
  return {
    get registered() {
      return [...registered];
    },
    refresh,
    unregister,
  };
}
