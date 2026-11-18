import { describe, expect, test } from "bun:test";
import {
  createToolRegistry,
  dataWriter,
  defineTool,
  deployment,
  type StandardSchemaV1,
  type ToolAuditEvent,
  type ToolDefinition,
} from "../src/tools.ts";
import {
  gatewayRequest,
  hostedEnvironment,
  localEnvironment,
  mcpCall,
  mcpTool,
  mcpToolNames,
  pageTool,
  TEST_ORIGIN,
  TEST_SUBJECT,
} from "../src/tools-testing.ts";

/** A tiny Standard Schema: an object with the given required string fields. */
function strings<const K extends string>(
  ...keys: K[]
): StandardSchemaV1<unknown, Record<K, string>> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value))
          return { issues: [{ message: "Expected an object." }] };
        const record = value as Record<string, unknown>;
        const extra = Object.keys(record).filter(
          (key) => !keys.includes(key as K),
        );
        if (extra.length > 0)
          return { issues: [{ message: "Unknown field.", path: extra }] };
        for (const key of keys)
          if (typeof record[key] !== "string")
            return { issues: [{ message: "Expected a string.", path: [key] }] };
        return { value: record as Record<K, string> };
      },
    },
  };
}

const schema = (...keys: string[]) => ({
  type: "object",
  properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
  required: keys,
  additionalProperties: false,
});

const records = new Map([["r1", { title: "Revize 1", revision: "a" }]]);

const findRecords = defineTool({
  name: "find_records",
  description: "Najde záznamy.",
  input: strings("query"),
  inputSchema: schema("query"),
  minRole: "user",
  effect: "read",
  untrustedContent: true,
  run: ({ query }) => ({
    ok: true,
    data: {
      items: [...records.entries()]
        .filter(([, record]) => record.title.includes(query))
        .map(([id, record]) => ({ id, ...record })),
    },
  }),
});

const saveDraft = defineTool({
  name: "save_record_draft",
  description: "Uloží koncept záznamu.",
  input: strings("id", "title", "base_revision"),
  inputSchema: schema("id", "title", "base_revision"),
  minRole: "user",
  effect: "write",
  publishesData: false,
  run: ({ id, base_revision }, context) => {
    const record = records.get(id);
    if (record === undefined)
      return { ok: false, reason: "not_found", message: "Záznam neexistuje." };
    if (record.revision !== base_revision)
      return {
        ok: false,
        reason: "record_changed",
        message: "Záznam se mezitím změnil.",
        current_revision: record.revision,
      };
    return { ok: true, data: { id, channel: context.channel } };
  },
});

const publishRecord = defineTool({
  name: "save_record",
  description: "Uloží a publikuje změnu záznamu.",
  input: strings("id"),
  inputSchema: schema("id"),
  minRole: "user",
  effect: "write",
  publishesData: true,
  run: ({ id }) => ({ ok: true, data: { id } }),
});

const publishTicket = defineTool({
  name: "create_ticket",
  description: "Založí a publikuje ticket.",
  input: strings("id"),
  inputSchema: schema("id"),
  minRole: "user",
  effect: "write",
  publishesData: true,
  publicationConsent: "plan DEV-0000, Owner 2026-11-14: agents publish tickets",
  run: ({ id }) => ({ ok: true, data: { id } }),
});

const prepareApproval = defineTool({
  name: "prepare_record_approval",
  description: "Připraví Schválení; schvaluje člověk.",
  input: strings("id"),
  inputSchema: schema("id"),
  minRole: "admin",
  effect: "prepare",
  run: ({ id }) => ({ ok: true, data: { id, ready: true } }),
});

const exportPdf = defineTool({
  name: "export_record_pdf",
  description: "Vyrobí PDF.",
  input: strings("id"),
  inputSchema: schema("id"),
  minRole: "user",
  effect: "read",
  run: ({ id }) => ({
    ok: true,
    data: { id },
    files: [
      {
        name: `${id}.pdf`,
        mimeType: "application/pdf",
        data: new TextEncoder().encode("%PDF-1.7"),
      },
    ],
  }),
});

const failing = defineTool({
  name: "break_things",
  description: "Selže.",
  input: strings(),
  inputSchema: schema(),
  minRole: "user",
  effect: "read",
  run: () => {
    throw new Error("secret detail /db/records.json");
  },
});

const TOOLS = [
  findRecords,
  saveDraft,
  publishRecord,
  publishTicket,
  prepareApproval,
  exportPdf,
  failing,
] as ToolDefinition<unknown>[];

function registry(
  env: Record<string, string>,
  audit: ToolAuditEvent[] = [],
  extra: Partial<Parameters<typeof createToolRegistry>[0]> = {},
) {
  return createToolRegistry({
    app: {
      module: "records",
      version: "1.2.3",
      dataGeneration: "v3",
      instructions: "Pravidla domény.",
    },
    tools: TOOLS,
    env,
    audit: (event) => audit.push(event),
    ...extra,
  });
}

const writer = registry(hostedEnvironment({ writer: true }));
const reader = registry(hostedEnvironment({ writer: false }));

describe("registry definition", () => {
  test("a tool name must be snake_case and unique", () => {
    const bad = { ...findRecords, name: "findRecords" };
    expect(() => registry(hostedEnvironment(), [], { tools: [bad] })).toThrow(
      "snake_case",
    );
    expect(() =>
      registry(hostedEnvironment(), [], { tools: [findRecords, findRecords] }),
    ).toThrow("twice");
    const shadow = { ...findRecords, name: "get_app_context" };
    expect(() =>
      registry(hostedEnvironment(), [], { tools: [shadow] }),
    ).toThrow("twice");
  });
});

describe("writer and deployment", () => {
  const app = { entry: "app", appRole: "user" } as const;
  const local = { entry: "local", appRole: "admin" } as const;
  test("true writes, any other value does not, unset only locally", () => {
    expect(
      dataWriter(app as never, { LAZURIO_RUNTIME_DATA_WRITER: "true" }),
    ).toBe(true);
    for (const value of ["false", "TRUE", "1", ""])
      expect(
        dataWriter(app as never, { LAZURIO_RUNTIME_DATA_WRITER: value }),
      ).toBe(false);
    expect(dataWriter(app as never, {})).toBe(false);
    expect(dataWriter(local as never, {})).toBe(true);
  });
  test("a host that sets the writer flag is production", () => {
    expect(deployment({ LAZURIO_RUNTIME_DATA_WRITER: "false" })).toBe(
      "production",
    );
    expect(deployment({})).toBe("environment");
    expect(
      deployment({
        LAZURIO_RUNTIME_DATA_WRITER: "true",
        LAZURIO_RUNTIME_DEPLOYMENT: "environment",
      }),
    ).toBe("environment");
  });
});

describe("/mcp transport", () => {
  test("initialize negotiates the protocol and names the App's version", async () => {
    const { status, body } = await mcpCall(writer, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "records", version: "1.2.3" },
      instructions: "Pravidla domény.",
    });
    const newer = await mcpCall(writer, "initialize", {
      protocolVersion: "2099-01-01",
    });
    expect(
      (newer.body.result as { protocolVersion: string }).protocolVersion,
    ).toBe("2025-11-25");
  });

  test("only POST, no batches, bounded body, JSON only", async () => {
    const get = await writer.handleMcp(gatewayRequest("/mcp"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const batch = await writer.handleMcp(
      gatewayRequest("/mcp", {
        body: [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      }),
    );
    expect(batch.status).toBe(400);
    const large = await writer.handleMcp(
      gatewayRequest("/mcp", {
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
          pad: "x".repeat(70_000),
        },
      }),
    );
    expect(large.status).toBe(413);
    const text = await writer.handleMcp(
      gatewayRequest("/mcp", {
        body: "ping",
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(text.status).toBe(415);
    const parse = await writer.handleMcp(
      gatewayRequest("/mcp", { body: "{not json" }),
    );
    expect(parse.status).toBe(400);
  });

  test("a notification is accepted without an answer", async () => {
    const response = await writer.handleMcp(
      gatewayRequest("/mcp", {
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("an unsupported protocol version header is refused", async () => {
    const response = await writer.handleMcp(
      gatewayRequest("/mcp", {
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
        headers: { "mcp-protocol-version": "1999-01-01" },
      }),
    );
    expect(response.status).toBe(400);
  });

  test("a foreign Origin is refused, a missing one is not", async () => {
    const foreign = await writer.handleMcp(
      gatewayRequest("/mcp", {
        origin: "https://evil.example",
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    expect(foreign.status).toBe(403);
    const own = await writer.handleMcp(
      gatewayRequest("/mcp", {
        origin: TEST_ORIGIN,
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      }),
    );
    expect(own.status).toBe(200);
  });

  test("without a stated person nothing is answered", async () => {
    const { status, body } = await mcpCall(
      writer,
      "tools/list",
      {},
      { caller: { role: "none" } },
    );
    expect(status).toBe(403);
    expect(body).toEqual({ error: "identity_unavailable" });
  });

  test("the list follows the role", async () => {
    expect(await mcpToolNames(writer, { role: "user" })).toEqual([
      "break_things",
      "create_ticket",
      "export_record_pdf",
      "find_records",
      "get_app_context",
      "save_record_draft",
    ]);
    expect(await mcpToolNames(writer, { role: "admin" })).toContain(
      "prepare_record_approval",
    );
    expect(await mcpToolNames(writer, { role: "environment" })).toContain(
      "prepare_record_approval",
    );
  });

  test("a tool the role does not have is refused, an unknown one too", async () => {
    const hidden = await mcpTool(writer, "prepare_record_approval", {
      id: "r1",
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.structured.reason).toBe("forbidden");
    const unknown = await mcpTool(writer, "drop_everything", {});
    expect(unknown.structured.reason).toBe("unknown_tool");
  });

  test("read-only mode hides writes and refuses a direct call", async () => {
    const names = await mcpToolNames(reader, { role: "admin" });
    expect(names).not.toContain("save_record_draft");
    expect(names).toContain("export_record_pdf");
    const call = await mcpTool(reader, "save_record_draft", {
      id: "r1",
      title: "x",
      base_revision: "a",
    });
    expect(call.structured.reason).toBe("data_read_only");
  });

  test("a tool that publishes data is not offered in production", async () => {
    expect(await mcpToolNames(writer, { role: "admin" })).not.toContain(
      "save_record",
    );
    const call = await mcpTool(writer, "save_record", { id: "r1" });
    expect(call.structured.reason).toBe("forbidden");
    const local = registry(localEnvironment());
    const response = await local.handleMcp(
      new Request("http://127.0.0.1:43100/mcp", {
        method: "POST",
        headers: {
          host: "127.0.0.1:43100",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const listed = (
      (await response.json()) as {
        result: { tools: Array<{ name: string }> };
      }
    ).result.tools.map((tool) => tool.name);
    expect(listed).toContain("save_record");
  });

  test("with the Owner's recorded consent a publishing write is offered in production", async () => {
    const names = await mcpToolNames(writer, { role: "user" });
    expect(names).toContain("create_ticket");
    expect(names).not.toContain("save_record");
    const call = await mcpTool(writer, "create_ticket", { id: "t1" });
    expect(call.structured).toEqual({ id: "t1" });
    expect(await mcpToolNames(reader, { role: "user" })).not.toContain(
      "create_ticket",
    );
    const viaPage = await pageTool(writer, "create_ticket", { id: "t2" });
    expect([viaPage.status, viaPage.body]).toEqual([
      200,
      { ok: true, data: { id: "t2" } },
    ]);
    const otherViaPage = await pageTool(writer, "save_record", { id: "r1" });
    expect([otherViaPage.status, otherViaPage.body.reason]).toEqual([
      403,
      "forbidden",
    ]);
    const readOnlyViaPage = await pageTool(reader, "create_ticket", {
      id: "t3",
    });
    expect(readOnlyViaPage.body.reason).toBe("data_read_only");
    const blank = registry(hostedEnvironment({ writer: true }), [], {
      tools: [
        {
          ...publishTicket,
          publicationConsent: "  ",
        } as ToolDefinition<unknown>,
      ],
    });
    expect(await mcpToolNames(blank, { role: "user" })).not.toContain(
      "create_ticket",
    );
  });

  test("annotations say what a tool does", async () => {
    const { body } = await mcpCall(
      writer,
      "tools/list",
      {},
      { caller: { role: "admin" } },
    );
    const tools = (body.result as { tools: Array<Record<string, unknown>> })
      .tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.find_records?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.save_record_draft?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.find_records?.effect).toBeUndefined();
  });

  test("get_app_context reports the App and the caller", async () => {
    const { isError, structured } = await mcpTool(
      writer,
      "get_app_context",
      {},
    );
    expect(isError).toBe(false);
    expect(structured).toEqual({
      module: "records",
      app_version: "1.2.3",
      data_generation: "v3",
      deployment: "production",
      entry: "app",
      app_role: "user",
      person: { subject: TEST_SUBJECT, username: "test-person" },
      can_write: true,
      channel: "mcp",
    });
  });

  test("invalid input is a tool refusal with the issues", async () => {
    const { isError, structured } = await mcpTool(writer, "find_records", {
      query: 3,
    });
    expect(isError).toBe(true);
    expect(structured.reason).toBe("invalid_input");
    expect(structured.details).toEqual({
      issues: [{ message: "Expected a string.", path: ["query"] }],
    });
  });

  test("record_changed carries the current revision", async () => {
    const { structured } = await mcpTool(writer, "save_record_draft", {
      id: "r1",
      title: "x",
      base_revision: "old",
    });
    expect(structured).toEqual({
      ok: false,
      reason: "record_changed",
      message: "Záznam se mezitím změnil.",
      current_revision: "a",
    });
  });

  test("a file comes back as an embedded resource", async () => {
    const { body } = await mcpCall(writer, "tools/call", {
      name: "export_record_pdf",
      arguments: { id: "r1" },
    });
    const content = (body.result as { content: Array<Record<string, unknown>> })
      .content;
    expect(content[1]).toEqual({
      type: "resource",
      resource: {
        uri: "urn:lazurio:records:file:r1.pdf",
        mimeType: "application/pdf",
        blob: btoa("%PDF-1.7"),
      },
    });
  });

  test("a failing tool says internal_error and leaks nothing", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const { structured } = await mcpTool(writer, "break_things", {});
      expect(structured).toEqual({
        ok: false,
        reason: "internal_error",
        message: "The tool failed.",
      });
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).not.toContain("secret detail");
  });

  test("every call is audited without input or answer", async () => {
    const audit: ToolAuditEvent[] = [];
    const audited = registry(hostedEnvironment({ writer: true }), audit);
    await mcpTool(audited, "find_records", { query: "secret-query" });
    await mcpTool(audited, "prepare_record_approval", { id: "r1" });
    expect(audit.map(({ durationMs: _d, ...event }) => event)).toEqual([
      {
        event: "agent-tool",
        channel: "mcp",
        tool: "find_records",
        entry: "app",
        subject: TEST_SUBJECT,
        appRole: "user",
        outcome: "ok",
      },
      {
        event: "agent-tool",
        channel: "mcp",
        tool: "prepare_record_approval",
        entry: "app",
        subject: TEST_SUBJECT,
        appRole: "user",
        outcome: "forbidden",
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("secret-query");
  });
});

describe("page transport", () => {
  test("the manifest lists the same tools as /mcp", async () => {
    for (const caller of [{ role: "user" }, { role: "admin" }] as const) {
      const response = await reader.handlePage(
        gatewayRequest("/api/agent-tools", { caller }),
      );
      const manifest = (await response?.json()) as {
        tools: Array<{ name: string; effect: string }>;
      };
      expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(
        await mcpToolNames(reader, caller),
      );
    }
  });

  test("a call goes through the same handler, with the webmcp channel", async () => {
    const { status, body } = await pageTool(writer, "save_record_draft", {
      id: "r1",
      title: "x",
      base_revision: "a",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { id: "r1", channel: "webmcp" } });
    const stale = await pageTool(writer, "save_record_draft", {
      id: "r1",
      title: "x",
      base_revision: "old",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.reason).toBe("record_changed");
    const readOnly = await pageTool(reader, "save_record_draft", {
      id: "r1",
      title: "x",
      base_revision: "a",
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.reason).toBe("data_read_only");
  });

  test("a call needs the page's own origin", async () => {
    for (const origin of [null, "https://evil.example"]) {
      const response = await writer.handlePage(
        gatewayRequest("/api/agent-tools/find_records", {
          origin,
          body: { query: "R" },
        }),
      );
      expect(response?.status).toBe(403);
    }
  });

  test("without a stated person the page gets no tools", async () => {
    const response = await writer.handlePage(
      gatewayRequest("/api/agent-tools", { caller: { role: "none" } }),
    );
    if (response === null) throw new Error("no answer");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe(
      "identity_unavailable",
    );
  });

  test("other paths are not the registry's", async () => {
    expect(await writer.handlePage(gatewayRequest("/api/records"))).toBeNull();
  });

  test("a file comes back as base64", async () => {
    const { body } = await pageTool(writer, "export_record_pdf", { id: "r1" });
    expect(body.files).toEqual([
      { name: "r1.pdf", mimeType: "application/pdf", base64: btoa("%PDF-1.7") },
    ]);
  });
});

describe("review of #6: origin boundary and failing validators", () => {
  const local = registry(localEnvironment());
  const localRequest = (
    path: string,
    origin: string | null,
    contentType: string,
    body: string,
  ) =>
    new Request(`http://127.0.0.1:43100${path}`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:43100",
        "content-type": contentType,
        ...(origin === null ? {} : { origin }),
      },
      body,
    });
  const draft = JSON.stringify({ id: "r1", title: "x", base_revision: "a" });

  test("a page on another loopback port cannot call a local App", async () => {
    for (const contentType of ["text/plain", "application/json"])
      for (const origin of [
        "http://localhost:9999",
        "http://127.0.0.1:9999",
        "https://127.0.0.1:43100",
        "http://127.0.0.2:43100",
      ]) {
        const response = await local.handlePage(
          localRequest(
            "/api/agent-tools/save_record_draft",
            origin,
            contentType,
            draft,
          ),
        );
        expect([origin, contentType, response?.status]).toEqual([
          origin,
          contentType,
          403,
        ]);
      }
  });

  test("the local App's own origin may call it, as JSON only", async () => {
    for (const origin of [
      "http://127.0.0.1:43100",
      "http://localhost:43100",
      "http://[::1]:43100",
    ]) {
      const ok = await local.handlePage(
        localRequest(
          "/api/agent-tools/save_record_draft",
          origin,
          "application/json; charset=utf-8",
          draft,
        ),
      );
      expect([origin, ok?.status]).toEqual([origin, 200]);
    }
    const plain = await local.handlePage(
      localRequest(
        "/api/agent-tools/save_record_draft",
        "http://127.0.0.1:43100",
        "text/plain",
        draft,
      ),
    );
    expect(plain?.status).toBe(415);
  });

  test("a hosted page call as text/plain is refused", async () => {
    const response = await writer.handlePage(
      gatewayRequest("/api/agent-tools/find_records", {
        origin: TEST_ORIGIN,
        body: JSON.stringify({ query: "R" }),
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(response?.status).toBe(415);
  });

  test("/mcp keeps the same origin boundary locally", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const foreign = await local.handleMcp(
      localRequest("/mcp", "http://localhost:9999", "application/json", ping),
    );
    expect(foreign.status).toBe(403);
    const own = await local.handleMcp(
      localRequest("/mcp", "http://localhost:43100", "application/json", ping),
    );
    expect(own.status).toBe(200);
    const none = await local.handleMcp(
      localRequest("/mcp", null, "application/json", ping),
    );
    expect(none.status).toBe(200);
    const plain = await local.handleMcp(
      localRequest("/mcp", null, "text/plain; x=json", ping),
    );
    expect(plain.status).toBe(415);
  });

  for (const [label, validate] of [
    [
      "throws",
      () => {
        throw new Error("validator detail");
      },
    ],
    ["rejects", () => Promise.reject(new Error("validator detail"))],
  ] as const) {
    test(`a validator that ${label} is internal_error, audited, on both transports`, async () => {
      const audit: ToolAuditEvent[] = [];
      const broken = defineTool({
        name: "broken_input",
        description: "Rozbitý validátor.",
        input: {
          "~standard": { version: 1, vendor: "test", validate },
        } as StandardSchemaV1<unknown, Record<string, never>>,
        inputSchema: schema(),
        minRole: "user",
        effect: "read",
        run: () => ({ ok: true, data: {} }),
      });
      const audited = registry(hostedEnvironment({ writer: true }), audit, {
        tools: [broken as ToolDefinition<unknown>],
      });
      const errors: string[] = [];
      const original = console.error;
      console.error = (line: string) => errors.push(line);
      try {
        const viaMcp = await mcpTool(audited, "broken_input", {});
        expect(viaMcp.structured).toEqual({
          ok: false,
          reason: "internal_error",
          message: "The tool failed.",
        });
        const viaPage = await pageTool(audited, "broken_input", {});
        expect(viaPage.status).toBe(500);
        expect(viaPage.body.reason).toBe("internal_error");
      } finally {
        console.error = original;
      }
      expect(audit.map((event) => [event.channel, event.outcome])).toEqual([
        ["mcp", "internal_error"],
        ["webmcp", "internal_error"],
      ]);
      expect(errors.join("\n")).not.toContain("validator detail");
    });
  }
});

describe("effectOf", () => {
  const post = (path: string, body: unknown) =>
    gatewayRequest(path, { body, origin: TEST_ORIGIN });
  test("a tool call has its tool's effect, and the request stays readable", async () => {
    const request = post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "save_record_draft", arguments: {} },
    });
    expect(await writer.effectOf(request)).toBe("write");
    expect(((await request.json()) as { method: string }).method).toBe(
      "tools/call",
    );
    expect(
      await writer.effectOf(
        post("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "export_record_pdf" },
        }),
      ),
    ).toBe("read");
    expect(
      await writer.effectOf(
        post("/api/agent-tools/prepare_record_approval", {}),
      ),
    ).toBe("prepare");
    expect(
      await writer.effectOf(post("/api/agent-tools/save_record", {})),
    ).toBe("write");
  });
  test("other MCP methods and the manifest read; unknown is null", async () => {
    expect(
      await writer.effectOf(
        post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      ),
    ).toBe("read");
    expect(await writer.effectOf(gatewayRequest("/api/agent-tools"))).toBe(
      "read",
    );
    expect(
      await writer.effectOf(
        post("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "nope" },
        }),
      ),
    ).toBeNull();
    expect(await writer.effectOf(post("/mcp", "{not json"))).toBeNull();
    expect(await writer.effectOf(post("/api/agent-tools/nope", {}))).toBeNull();
  });
});

describe("review of #6 round 3: effectOf only for tool requests", () => {
  const post = (path: string, body: unknown) =>
    gatewayRequest(path, { body, origin: TEST_ORIGIN });
  test("an ordinary App request is not a tool request", async () => {
    expect(
      await writer.effectOf(post("/api/records", { title: "changed" })),
    ).toBeNull();
    expect(
      await writer.effectOf(
        post("/api/records", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      ),
    ).toBeNull();
    expect(await writer.effectOf(gatewayRequest("/api/records"))).toBeNull();
    expect(
      await writer.effectOf(post("/mcp/extra", { method: "ping" })),
    ).toBeNull();
  });
  test("a malformed page tool path is null, and the page answers unknown_tool", async () => {
    expect(await writer.effectOf(post("/api/agent-tools/%ZZ", {}))).toBeNull();
    expect(
      await writer.effectOf(post("/api/agent-tools/a%2Fb", {})),
    ).toBeNull();
    const response = await writer.handlePage(post("/api/agent-tools/%ZZ", {}));
    expect(response?.status).toBe(404);
  });
  test("a custom MCP path is the one classified", async () => {
    const custom = registry(hostedEnvironment({ writer: true }), [], {
      mcpPath: "/agents/mcp",
    });
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "save_record_draft" },
    };
    expect(await custom.effectOf(post("/agents/mcp", call))).toBe("write");
    expect(await custom.effectOf(post("/mcp", call))).toBeNull();
  });
});

describe("dataWriter in a runtime that states production (#9)", () => {
  const entries = [
    { entry: "local", appRole: "admin" },
    { entry: "environment", appRole: "admin" },
    { entry: "app", appRole: "admin" },
    { entry: "app", appRole: "user" },
    { entry: "unknown", appRole: null },
  ] as const;
  test("without the writer variable no entry writes", () => {
    for (const access of entries)
      expect([
        access.entry,
        dataWriter(access as never, {
          LAZURIO_RUNTIME_DEPLOYMENT: "production",
        }),
      ]).toEqual([access.entry, false]);
  });
  test("the writer variable still decides where it is set", () => {
    for (const access of entries) {
      expect(
        dataWriter(access as never, {
          LAZURIO_RUNTIME_DEPLOYMENT: "production",
          LAZURIO_RUNTIME_DATA_WRITER: "true",
        }),
      ).toBe(true);
      expect(
        dataWriter(access as never, {
          LAZURIO_RUNTIME_DEPLOYMENT: "production",
          LAZURIO_RUNTIME_DATA_WRITER: "false",
        }),
      ).toBe(false);
    }
  });
  test("a development version still lets a local or Environment entry write", () => {
    for (const env of [{}, { LAZURIO_RUNTIME_DEPLOYMENT: "environment" }])
      expect(entries.map((access) => dataWriter(access as never, env))).toEqual(
        [true, true, false, false, false],
      );
  });
  test("a registry in such a runtime offers no write tool to a local entry", async () => {
    const env = {
      ...localEnvironment(),
      LAZURIO_RUNTIME_DEPLOYMENT: "production",
    };
    const local = registry(env);
    const response = await local.handleMcp(
      new Request("http://127.0.0.1:43100/mcp", {
        method: "POST",
        headers: {
          host: "127.0.0.1:43100",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const names = (
      (await response.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name);
    expect(names).not.toContain("save_record_draft");
    expect(names).toContain("find_records");
  });
});
