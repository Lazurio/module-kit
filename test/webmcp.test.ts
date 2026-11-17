import { describe, expect, test } from "bun:test";
import { createToolRegistry, defineTool } from "../src/tools.ts";
import {
  type GatewayCaller,
  gatewayRequest,
  hostedEnvironment,
  TEST_ORIGIN,
} from "../src/tools-testing.ts";
import {
  type ModelContextLike,
  registerAgentTools,
  type WebMcpTool,
} from "../src/webmcp.ts";

const anyObject = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
  },
};

function makeRegistry(writer: boolean) {
  return createToolRegistry({
    app: { module: "records", version: "1.0.0", dataGeneration: "v3" },
    env: hostedEnvironment({ writer }),
    audit: () => {},
    tools: [
      defineTool({
        name: "find_records",
        description: "Najde záznamy.",
        input: anyObject,
        inputSchema: { type: "object" },
        minRole: "user",
        effect: "read",
        untrustedContent: true,
        run: (input, context) => ({
          ok: true,
          data: { input, channel: context.channel },
        }),
      }),
      defineTool({
        name: "save_record_draft",
        description: "Uloží koncept.",
        input: anyObject,
        inputSchema: { type: "object" },
        minRole: "user",
        effect: "write",
        publishesData: false,
        run: () => ({ ok: true, data: { saved: true } }),
      }),
    ],
  });
}

/** A fetch that sends the page's requests through the gateway to a registry. */
function pageFetch(
  registry: ReturnType<typeof makeRegistry>,
  caller: GatewayCaller,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    const body = init?.body === undefined ? undefined : String(init.body);
    const request = gatewayRequest(path, {
      caller,
      method: init?.method ?? "GET",
      origin: init?.method === "POST" ? TEST_ORIGIN : null,
      ...(body === undefined ? {} : { body }),
    });
    return (
      (await registry.handlePage(request)) ??
      new Response("not found", { status: 404 })
    );
  }) as typeof fetch;
}

function fakeContext() {
  const tools = new Map<string, WebMcpTool>();
  const context: ModelContextLike = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => tools.delete(tool.name));
    },
  };
  return { tools, context };
}

describe("registerAgentTools", () => {
  test("registers the server's tools for this person and calls the server", async () => {
    const { tools, context } = fakeContext();
    const agentTools = await registerAgentTools({
      modelContext: context,
      fetch: pageFetch(makeRegistry(true), { role: "user" }),
    });
    expect([...agentTools.registered].sort()).toEqual([
      "find_records",
      "get_app_context",
      "save_record_draft",
    ]);
    expect(tools.get("find_records")?.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    const answer = await tools.get("find_records")?.execute({ query: "R" });
    expect(answer).toEqual({
      ok: true,
      data: { input: { query: "R" }, channel: "webmcp" },
    });
  });

  test("in read-only mode the page offers no write tool", async () => {
    const { tools, context } = fakeContext();
    await registerAgentTools({
      modelContext: context,
      fetch: pageFetch(makeRegistry(false), { role: "admin" }),
    });
    expect(tools.has("save_record_draft")).toBe(false);
    expect(tools.has("find_records")).toBe(true);
  });

  test("without a stated person the page registers no server tool", async () => {
    const { tools, context } = fakeContext();
    await registerAgentTools({
      modelContext: context,
      fetch: pageFetch(makeRegistry(true), { role: "none" }),
      viewTools: [
        {
          name: "open_record",
          description: "Otevře záznam.",
          inputSchema: { type: "object" },
          execute: () => ({ ok: true }),
        },
      ],
    });
    expect([...tools.keys()]).toEqual(["open_record"]);
  });

  test("a view tool never shadows a server tool and its failure is an answer", async () => {
    const { tools, context } = fakeContext();
    await registerAgentTools({
      modelContext: context,
      fetch: pageFetch(makeRegistry(true), { role: "user" }),
      viewTools: [
        {
          name: "find_records",
          description: "Stínová verze.",
          inputSchema: { type: "object" },
          execute: () => ({ shadow: true }),
        },
        {
          name: "open_record",
          description: "Otevře záznam.",
          inputSchema: { type: "object" },
          execute: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    expect(tools.get("find_records")?.description).toBe("Najde záznamy.");
    expect(await tools.get("open_record")?.execute({})).toEqual({
      ok: false,
      reason: "internal_error",
      message: "The view tool failed.",
    });
  });

  test("refresh follows a change of role, unregister removes everything", async () => {
    const { tools, context } = fakeContext();
    let caller: GatewayCaller = { role: "none" };
    const registry = makeRegistry(true);
    const agentTools = await registerAgentTools({
      modelContext: context,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        pageFetch(registry, caller)(input, init)) as typeof fetch,
    });
    expect(tools.size).toBe(0);
    caller = { role: "user" };
    await agentTools.refresh();
    expect(tools.has("find_records")).toBe(true);
    agentTools.unregister();
    expect(tools.size).toBe(0);
    expect(agentTools.registered).toEqual([]);
  });

  test("without the WebMCP API nothing happens and nothing throws", async () => {
    const agentTools = await registerAgentTools({
      modelContext: null,
      fetch: (() => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(agentTools.registered).toEqual([]);
  });

  test("a non-JSON answer becomes an unavailable refusal", async () => {
    const { tools, context } = fakeContext();
    await registerAgentTools({
      modelContext: context,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response("<html>", { status: 502 })
          : Response.json({
              tools: [
                {
                  name: "find_records",
                  description: "x",
                  inputSchema: {},
                  effect: "read",
                  annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                    untrustedContentHint: false,
                  },
                },
              ],
            })) as typeof fetch,
    });
    expect(await tools.get("find_records")?.execute({})).toEqual({
      ok: false,
      reason: "unavailable",
      message: "The App answered HTTP 502.",
    });
  });
});
