import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedHosts,
  appAccess,
  astroServerOptions,
  GATEWAY_HEADERS,
  health,
  isLazurioUsername,
  listener,
  listeners,
  listenerVariableKey,
  ModuleKitError,
  onShutdown,
  requireEnvironment,
  runtimeIdentity,
  type ShutdownProcess,
  viteServerOptions,
  withHealth,
} from "../src/index.ts";

const APP = {
  LAZURIO_RUNTIME_LISTENER_APP_HOST: "127.0.0.1",
  LAZURIO_RUNTIME_LISTENER_APP_PORT: "43100",
};
const HOSTED = {
  ...APP,
  LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN:
    "https://deals.vm-01.example.lazurio.io",
};

function thrown(fn: () => unknown): ModuleKitError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ModuleKitError) return error;
    throw error;
  }
  throw new Error("expected a ModuleKitError");
}

describe("listener", () => {
  test("reads host and port, no origin on a workstation", () => {
    expect(listener("app", APP)).toEqual({
      host: "127.0.0.1",
      port: 43100,
      externalOrigin: null,
    });
  });

  test("id is case-insensitive and maps - to _", () => {
    expect(listenerVariableKey("admin-api")).toBe("ADMIN_API");
    const env = {
      LAZURIO_RUNTIME_LISTENER_ADMIN_API_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_LISTENER_ADMIN_API_PORT: "43101",
    };
    expect(listener("admin-api", env).port).toBe(43101);
    expect(listener("APP", APP).port).toBe(43100);
  });

  test("reads the external origin when hosted", () => {
    expect(listener("app", HOSTED).externalOrigin).toBe(
      "https://deals.vm-01.example.lazurio.io",
    );
  });

  test("missing host names the exact variable", () => {
    const error = thrown(() =>
      listener("app", { LAZURIO_RUNTIME_LISTENER_APP_PORT: "43100" }),
    );
    expect(error.code).toBe("listener-missing");
    expect(error.message).toContain("LAZURIO_RUNTIME_LISTENER_APP_HOST");
  });

  test("missing port names the exact variable", () => {
    const error = thrown(() =>
      listener("app", { LAZURIO_RUNTIME_LISTENER_APP_HOST: "127.0.0.1" }),
    );
    expect(error.code).toBe("listener-missing");
    expect(error.message).toContain("LAZURIO_RUNTIME_LISTENER_APP_PORT");
  });

  test.each(["", "0", "65536", "80a", "-1", "4.5", " 80"])(
    "invalid port %p is refused",
    (port) => {
      const error = thrown(() =>
        listener("app", { ...APP, LAZURIO_RUNTIME_LISTENER_APP_PORT: port }),
      );
      expect(error.code).toBe("listener-missing");
      expect(error.message).toContain("LAZURIO_RUNTIME_LISTENER_APP_PORT");
    },
  );

  test("never falls back to PORT or LAZURIO_RUNTIME_HOST/PORT", () => {
    const error = thrown(() =>
      listener("app", {
        PORT: "3000",
        HOST: "127.0.0.1",
        LAZURIO_RUNTIME_HOST: "127.0.0.1",
        LAZURIO_RUNTIME_PORT: "43100",
      }),
    );
    expect(error.code).toBe("listener-missing");
  });

  test.each([
    "deals.example.lazurio.io",
    "https://deals.example.lazurio.io/",
    "https://deals.example.lazurio.io/app",
    "ftp://deals.example.lazurio.io",
  ])("invalid external origin %p is refused", (origin) => {
    const error = thrown(() =>
      listener("app", {
        ...APP,
        LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN: origin,
      }),
    );
    expect(error.code).toBe("listener-missing");
    expect(error.message).toContain(
      "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN",
    );
  });
});

describe("listeners", () => {
  test("prefers LAZURIO_RUNTIME_LISTENERS_JSON", () => {
    const env = {
      ...APP,
      LAZURIO_RUNTIME_LISTENERS_JSON: JSON.stringify([
        {
          id: "app",
          role: "entrypoint",
          allocation: "static",
          host: "127.0.0.1",
          port: 43100,
          protocol: "http",
          health: "/healthz",
          claim: { mode: "exclusive" },
          external_origin: "https://deals.example.lazurio.io",
        },
        { id: "admin-api", role: "internal", host: "127.0.0.1", port: 43101 },
      ]),
    };
    expect(listeners(env)).toEqual([
      {
        id: "app",
        host: "127.0.0.1",
        port: 43100,
        externalOrigin: "https://deals.example.lazurio.io",
      },
      { id: "admin-api", host: "127.0.0.1", port: 43101, externalOrigin: null },
    ]);
  });

  test("derives from listener variables without JSON", () => {
    const env = {
      ...HOSTED,
      LAZURIO_RUNTIME_LISTENER_ADMIN_API_HOST: "127.0.0.1",
      LAZURIO_RUNTIME_LISTENER_ADMIN_API_PORT: "43101",
      LAZURIO_RUNTIME_HOST: "127.0.0.1",
    };
    expect(listeners(env)).toEqual([
      { id: "admin-api", host: "127.0.0.1", port: 43101, externalOrigin: null },
      {
        id: "app",
        host: "127.0.0.1",
        port: 43100,
        externalOrigin: "https://deals.vm-01.example.lazurio.io",
      },
    ]);
  });

  test("no listener variables is an empty list", () => {
    expect(listeners({ PORT: "3000" })).toEqual([]);
  });

  test("derived listener with a bad port fails closed", () => {
    const error = thrown(() =>
      listeners({ LAZURIO_RUNTIME_LISTENER_APP_HOST: "127.0.0.1" }),
    );
    expect(error.code).toBe("listener-missing");
  });

  test.each([
    ["not json", "{"],
    ["not an array", "{}"],
    ["entry not an object", "[1]"],
    ["no id", '[{"host":"127.0.0.1","port":1}]'],
    ["no host", '[{"id":"app","port":1}]'],
    ["bad port", '[{"id":"app","host":"127.0.0.1","port":70000}]'],
    ["string port", '[{"id":"app","host":"127.0.0.1","port":"80"}]'],
    [
      "bad origin",
      '[{"id":"app","host":"127.0.0.1","port":80,"external_origin":"x"}]',
    ],
  ])("invalid JSON (%s) is refused", (_, json) => {
    const error = thrown(() =>
      listeners({ LAZURIO_RUNTIME_LISTENERS_JSON: json }),
    );
    expect(error.code).toBe("listeners-invalid");
  });
});

describe("runtimeIdentity", () => {
  test("returns the identity when all three are set", () => {
    expect(
      runtimeIdentity({
        LAZURIO_RUNTIME_SCHEMA_VERSION: "lazurio.runtime.v1",
        LAZURIO_RUNTIME_APP_ID: "deals",
        LAZURIO_RUNTIME_ENTRYPOINT_ID: "app",
      }),
    ).toEqual({
      schemaVersion: "lazurio.runtime.v1",
      appId: "deals",
      entrypointId: "app",
    });
  });

  test("returns null when not started by Lazurio or incomplete", () => {
    expect(runtimeIdentity({})).toBeNull();
    expect(
      runtimeIdentity({
        LAZURIO_RUNTIME_SCHEMA_VERSION: "lazurio.runtime.v1",
        LAZURIO_RUNTIME_APP_ID: "deals",
      }),
    ).toBeNull();
  });
});

describe("dev server options", () => {
  test("allowedHosts is loopback on a workstation", () => {
    expect(allowedHosts("app", APP)).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  test("allowedHosts adds the external hostname when hosted", () => {
    expect(allowedHosts("app", HOSTED)).toEqual([
      "deals.vm-01.example.lazurio.io",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
  });

  test("viteServerOptions", () => {
    expect(viteServerOptions("app", HOSTED)).toEqual({
      host: "127.0.0.1",
      port: 43100,
      strictPort: true,
      allowedHosts: [
        "deals.vm-01.example.lazurio.io",
        "localhost",
        "127.0.0.1",
        "::1",
      ],
    });
  });

  test("astroServerOptions", () => {
    expect(astroServerOptions("app", APP)).toEqual({
      host: "127.0.0.1",
      port: 43100,
      allowedHosts: ["localhost", "127.0.0.1", "::1"],
    });
  });

  test("options fail closed without the listener", () => {
    expect(thrown(() => viteServerOptions("app", {})).code).toBe(
      "listener-missing",
    );
    expect(thrown(() => astroServerOptions("app", {})).code).toBe(
      "listener-missing",
    );
    expect(thrown(() => allowedHosts("app", {})).code).toBe("listener-missing");
  });
});

describe("health", () => {
  const request = new Request("http://127.0.0.1/healthz");

  test("200 ok when ready", async () => {
    const response = await health(() => true)(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("503 starting when not ready", async () => {
    const response = await health(async () => false)(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "starting" });
  });

  test("503 when ready throws", async () => {
    const response = await health(() => {
      throw new Error("db down");
    })(request);
    expect(response.status).toBe(503);
  });

  test("withHealth answers the path and passes the rest through", async () => {
    let ready = false;
    const handler = withHealth(
      () => new Response("app"),
      "/healthz",
      () => ready,
    );
    expect((await handler(request)).status).toBe(503);
    ready = true;
    expect((await handler(request)).status).toBe(200);
    const other = await handler(new Request("http://127.0.0.1/"));
    expect(await other.text()).toBe("app");
  });

  test("withHealth works as a Bun.serve fetch handler", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: withHealth(() => new Response("hello")),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const healthy = await fetch(`${base}/healthz`);
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ status: "ok" });
      expect(await (await fetch(`${base}/`)).text()).toBe("hello");
    } finally {
      await server.stop(true);
    }
  });
});

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exits: number[] = [];
  override on(signal: string, listener: () => void): this {
    return super.on(signal, listener);
  }
  override off(signal: string, listener: () => void): this {
    return super.off(signal, listener);
  }
  exit(code: number) {
    this.exits.push(code);
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("onShutdown", () => {
  test("SIGTERM runs fn once and exits 0", async () => {
    const fake = new FakeProcess();
    let calls = 0;
    onShutdown(
      async () => {
        calls += 1;
      },
      { process: fake },
    );
    fake.emit("SIGTERM");
    fake.emit("SIGTERM");
    fake.emit("SIGINT");
    await tick();
    expect(calls).toBe(1);
    expect(fake.exits).toEqual([0]);
  });

  test("SIGINT is handled too", async () => {
    const fake = new FakeProcess();
    onShutdown(() => {}, { process: fake });
    fake.emit("SIGINT");
    await tick();
    expect(fake.exits).toEqual([0]);
  });

  test("exits 1 after the timeout, only once", async () => {
    const fake = new FakeProcess();
    let release = () => {};
    onShutdown(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { process: fake, timeoutMs: 20 },
    );
    fake.emit("SIGTERM");
    await tick(5);
    expect(fake.exits).toEqual([]);
    await tick(40);
    expect(fake.exits).toEqual([1]);
    release();
    await tick();
    expect(fake.exits).toEqual([1]);
  });

  test("exits 1 when fn throws", async () => {
    const fake = new FakeProcess();
    onShutdown(
      () => {
        throw new Error("close failed");
      },
      { process: fake },
    );
    fake.emit("SIGTERM");
    await tick();
    expect(fake.exits).toEqual([1]);
  });

  test("the returned function removes the handlers", () => {
    const fake = new FakeProcess();
    const dispose = onShutdown(() => {}, { process: fake });
    expect(fake.listenerCount("SIGTERM")).toBe(1);
    expect(fake.listenerCount("SIGINT")).toBe(1);
    dispose();
    expect(fake.listenerCount("SIGTERM")).toBe(0);
    expect(fake.listenerCount("SIGINT")).toBe(0);
  });
});

describe("requireEnvironment", () => {
  test("returns the values", () => {
    expect(requireEnvironment(["A", "B"], { A: "1", B: "2", C: "3" })).toEqual({
      A: "1",
      B: "2",
    });
  });

  test("names every missing or empty variable", () => {
    const error = thrown(() =>
      requireEnvironment(["A", "B", "C"], { A: "1", B: "" }),
    );
    expect(error.code).toBe("environment-missing");
    expect(error.message).toContain("B, C");
  });
});

// ---------------------------------------------------------------- viteShutdownPlugin

import { viteShutdownPlugin } from "../src/index";

function fakeProcess() {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    process: {
      on(signal: string, handler: () => void) {
        handlers.set(signal, handler);
      },
      off(signal: string) {
        handlers.delete(signal);
      },
      exit(code: number) {
        exits.push(code);
      },
    },
    handlers,
    exits,
  };
}

test("viteShutdownPlugin closes every connection, bounds close() and exits 0 on SIGTERM", async () => {
  const fake = fakeProcess();
  let closedConnections = 0;
  let closeCalls = 0;
  const server = {
    httpServer: {
      closeAllConnections: () => {
        closedConnections += 1;
      },
    },
    close: () => {
      closeCalls += 1;
      return new Promise<void>(() => {}); // never resolves: a hung close
    },
  };
  const plugin = viteShutdownPlugin({
    closeTimeoutMs: 20,
    shutdown: { process: fake.process as never },
  });
  plugin.configureServer(server);
  fake.handlers.get("SIGTERM")?.();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(closedConnections).toBe(1);
  expect(closeCalls).toBe(1);
  expect(fake.exits).toEqual([0]);
});

test("viteShutdownPlugin exits 0 as soon as close() resolves", async () => {
  const fake = fakeProcess();
  const server = { close: async () => {} };
  const plugin = viteShutdownPlugin({
    closeTimeoutMs: 1_000,
    shutdown: { process: fake.process as never },
  });
  plugin.configurePreviewServer(server);
  fake.handlers.get("SIGINT")?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fake.exits).toEqual([0]);
});

describe("appAccess", () => {
  const HOST = "deals.vm-01.example.lazurio.io";
  const ALENA = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const BOB = "9a8b7c6d-5e4f-4321-8fed-cba987654321";
  const through = (extra: Record<string, string> = {}, host = HOST) =>
    new Request(`https://${HOST}/api/me`, {
      headers: { host, ...extra },
    });
  const person = (subject = ALENA, entry = "environment") => ({
    [GATEWAY_HEADERS.subject]: subject,
    [GATEWAY_HEADERS.username]: "alena",
    [GATEWAY_HEADERS.entry]: entry,
  });
  const unknown = {
    entry: "unknown",
    appRole: null,
    person: null,
    source: null,
    reason: "no-identity",
  } as const;
  const local = (
    reason: "not-hosted" | "not-through-gateway" | "local-entry",
  ) =>
    ({
      entry: "local",
      appRole: "admin",
      person: null,
      source: null,
      reason,
    }) as const;

  test("the whole Environment: an Application Admin with the person", () => {
    expect(appAccess(through(person()), "app", HOSTED)).toEqual({
      entry: "environment",
      appRole: "admin",
      person: { subject: ALENA, username: "alena" },
      source: "gateway",
      reason: null,
    });
  });

  test("this App only: the application role the gateway stated", () => {
    for (const appRole of ["admin", "user"] as const)
      expect(
        appAccess(
          through({
            ...person(ALENA, "app"),
            [GATEWAY_HEADERS.appRole]: appRole,
          }),
          "app",
          HOSTED,
        ),
      ).toEqual({
        entry: "app",
        appRole,
        person: { subject: ALENA, username: "alena" },
        source: "gateway",
        reason: null,
      });
  });

  test("every answer has the same five fields", () => {
    for (const answer of [
      appAccess(through(person()), "app", HOSTED),
      appAccess(through(), "app", HOSTED),
      appAccess(through({}, "127.0.0.1:43100"), "app", HOSTED),
      appAccess(through(), "app", APP),
    ])
      expect(Object.keys(answer).sort()).toEqual([
        "appRole",
        "entry",
        "person",
        "reason",
        "source",
      ]);
  });

  test("this App only without a valid role is unknown, never a role", () => {
    for (const role of [undefined, "", "Admin", "owner", "admin, user"])
      expect(
        appAccess(
          through({
            ...person(ALENA, "app"),
            ...(role === undefined ? {} : { [GATEWAY_HEADERS.appRole]: role }),
          }),
          "app",
          HOSTED,
        ),
      ).toEqual(unknown);
  });

  test("reads plain headers too (any server)", () => {
    const headers = new Headers({ host: HOST, ...person() });
    expect(appAccess(headers, "app", HOSTED)).toMatchObject({
      entry: "environment",
      appRole: "admin",
    });
  });

  test("the gateway's hostname in any letter case, with a port or a trailing dot, counts only by its statement", () => {
    for (const host of [
      "DEALS.VM-01.EXAMPLE.LAZURIO.IO",
      `${HOST}:443`,
      `${HOST}:8443`,
      `${HOST}.`,
      `Deals.Vm-01.Example.Lazurio.Io.:443`,
    ]) {
      // A visitor with this App only stays an Application User, never a local
      // Application Admin.
      expect(
        appAccess(
          through(
            { ...person(ALENA, "app"), [GATEWAY_HEADERS.appRole]: "user" },
            host,
          ),
          "app",
          HOSTED,
        ),
      ).toMatchObject({ entry: "app", appRole: "user" });
      // Without a statement it is unknown, never local.
      expect(appAccess(through({}, host), "app", HOSTED)).toEqual(unknown);
    }
  });

  test("without a gateway every request is local, whatever it carries", () => {
    const forged = new Request("http://127.0.0.1:43100/", {
      headers: {
        host: "127.0.0.1:43100",
        ...person(ALENA, "app"),
        [GATEWAY_HEADERS.appRole]: "user",
      },
    });
    expect(appAccess(forged, "app", APP)).toEqual(local("not-hosted"));
  });

  test("a request to a loopback address is local", () => {
    for (const host of [
      "127.0.0.1:43100",
      "127.0.0.1",
      "localhost:43100",
      "LOCALHOST",
      "[::1]:43100",
    ])
      expect(
        appAccess(
          new Request("http://127.0.0.1:43100/", {
            headers: { host, ...person() },
          }),
          "app",
          HOSTED,
        ),
      ).toEqual(local("not-through-gateway"));
  });

  test("any other Host is unknown, never local", () => {
    for (const host of [
      "notes.vm-01.example.lazurio.io",
      "deals.vm-01.example.lazurio.io.evil.test",
      "evil.test",
      "",
      "127.0.0.1.evil.test",
    ])
      expect(appAccess(through(person(), host), "app", HOSTED)).toEqual(
        unknown,
      );
  });

  test("the Environment browser's local entry is local without a name", () => {
    expect(
      appAccess(through({ [GATEWAY_HEADERS.entry]: "local" }), "app", HOSTED),
    ).toEqual(local("local-entry"));
  });

  test("through the gateway, a missing, repeated or malformed statement is unknown", () => {
    const cases: Record<string, string>[] = [
      {},
      { [GATEWAY_HEADERS.subject]: ALENA },
      { ...person(), [GATEWAY_HEADERS.entry]: "full" },
      { ...person(), [GATEWAY_HEADERS.entry]: "local" },
      { ...person(""), [GATEWAY_HEADERS.entry]: "environment" },
      person(ALENA.toUpperCase()),
      person(`${ALENA}0`),
      person("alena"),
      person(`${ALENA}, ${BOB}`),
      { ...person(), [GATEWAY_HEADERS.entry]: "environment, app" },
      { [GATEWAY_HEADERS.entry]: "local, local" },
      {
        [GATEWAY_HEADERS.entry]: "local",
        [GATEWAY_HEADERS.username]: "alena",
      },
      {
        [GATEWAY_HEADERS.entry]: "local",
        [GATEWAY_HEADERS.appRole]: "user",
      },
    ];
    for (const headers of cases)
      expect(appAccess(through(headers), "app", HOSTED)).toEqual(unknown);
    // A repeated subject next to a local entry is no local entry.
    const repeated = new Headers({ host: HOST });
    repeated.append(GATEWAY_HEADERS.entry, "local");
    repeated.append(GATEWAY_HEADERS.subject, ALENA);
    repeated.append(GATEWAY_HEADERS.subject, BOB);
    expect(appAccess(repeated, "app", HOSTED)).toEqual(unknown);
  });

  test("a username outside the Lazurio rule is no username", () => {
    for (const username of [
      "Alena",
      "al",
      "a".repeat(40),
      "-alena",
      "ale--na",
      ALENA,
      "service-account-pilot",
      "alena, bob",
    ])
      expect(
        appAccess(
          through({ ...person(), [GATEWAY_HEADERS.username]: username }),
          "app",
          HOSTED,
        ).person,
      ).toEqual({ subject: ALENA, username: null });
    expect(isLazurioUsername("bob-example")).toBe(true);
  });

  test("per request: another account on the next request is that person", () => {
    expect(appAccess(through(person()), "app", HOSTED).person).toMatchObject({
      subject: ALENA,
    });
    expect(appAccess(through(person(BOB)), "app", HOSTED).person).toMatchObject(
      { subject: BOB },
    );
  });

  test("an App started outside Lazurio fails like listener()", () => {
    expect(thrown(() => appAccess(through(), "app", {})).code).toBe(
      "listener-missing",
    );
  });
});

// ---------------------------------------------------------------- viteDevFramePlugin

import {
  bunDevFramePlugin,
  devFrameHtml,
  viteDevFramePlugin,
} from "../src/index";

const page =
  '<!doctype html>\n<html lang="cs">\n<head><title>x</title></head>\n<body><div id="root"></div></body>\n</html>';
const SHELL = "http://127.0.0.1:20000/.lazurio/shell.js";
const DEV = { LAZURIO_RUNTIME_SHELL_SCRIPT: SHELL };
const INSERTED = `<script type="module" src="${SHELL}"></script><lazurio-buddy version="dev"></lazurio-buddy>`;

test("viteDevFramePlugin runs only while serving", () => {
  const plugin = viteDevFramePlugin({}, DEV);
  expect(plugin.apply).toBe("serve");
  expect(plugin.name).toBe("lazurio-module-kit-dev-frame");
  expect(plugin.transformIndexHtml.order).toBe("post");
});

test("in a DEV run both plugins insert the shell script and <lazurio-buddy version=dev>, and draw nothing themselves", () => {
  const html = viteDevFramePlugin(
    { lang: "cs" },
    DEV,
  ).transformIndexHtml.handler(page);
  expect(html).toContain('<html data-lazurio-shell="host" lang="cs">');
  const inserted = `<script type="module" src="${SHELL}"></script><lazurio-buddy version="dev" lang="cs"></lazurio-buddy>`;
  expect(html).toContain(`${inserted}</body>`);
  expect(devFrameHtml(page, { lang: "cs" }, DEV)).toBe(html);
  // Nothing of module-kit's own beyond the two tags and the mark: no style,
  // colour or text.
  expect(html.replace(inserted, "")).toBe(
    page.replace("<html", '<html data-lazurio-shell="host"'),
  );
  expect(inserted).not.toMatch(/style|color|DEV/);
});

test("a run that is not DEV gets nothing, also from a shared config (STAGING, PROD)", () => {
  for (const env of [{}, { LAZURIO_RUNTIME_SHELL_SCRIPT: "" }]) {
    expect(
      viteDevFramePlugin({ lang: "cs" }, env).transformIndexHtml.handler(page),
    ).toBe(page);
    expect(devFrameHtml(page, { lang: "cs" }, env)).toBe(page);
  }
});

test("the frame goes before the real </body>, never into a script, a style, a comment or an attribute", () => {
  const tricky = [
    "<!doctype html>",
    "<!-- <html> and </body> in a comment -->",
    '<html lang="cs"><head><title>a </body> title</title>',
    '<style>.x::after { content: "</body>"; }</style></head>',
    '<body data-note="a > b </body>"><script>const example = "</body>";</script>',
    "<textarea></body></textarea><p>text</p></body></html>",
  ].join("\n");
  const html = devFrameHtml(tricky, {}, DEV);
  expect(html.split(INSERTED)).toHaveLength(2);
  expect(html).toContain(`<p>text</p>${INSERTED}</body></html>`);
  // The Vite plugin serves the same page: Vite's own tag injection would put
  // the tags into the script's string.
  expect(viteDevFramePlugin({}, DEV).transformIndexHtml.handler(tricky)).toBe(
    html,
  );
  expect(html).toContain('<script>const example = "</body>";</script>');
  expect(html).toContain("<!-- <html> and </body> in a comment -->");
  expect(html).toContain('<html data-lazurio-shell="host" lang="cs">');
  // A page without </body> gets the frame at its end; one without <html>
  // keeps its markup.
  expect(devFrameHtml("<p>x</p>", {}, DEV)).toBe(`<p>x</p>${INSERTED}`);
  // A raw text element ends only at its real end tag, never at
  // `</scripture>`.
  const scripture =
    '<html lang="cs"><body><script>const example = "</scripture></body><style>";</script><p>x</p></body></html>';
  const scriptured = devFrameHtml(scripture, {}, DEV);
  expect(scriptured).toContain(
    'const example = "</scripture></body><style>";</script>',
  );
  expect(scriptured).toContain(`<p>x</p>${INSERTED}</body></html>`);
  // The attribute is the tag's own, never text inside a quoted value.
  const quoted =
    '<html data-note="example data-lazurio-shell=page" lang="cs"><body></body></html>';
  expect(devFrameHtml(quoted, {}, DEV)).toContain(
    '<html data-lazurio-shell="host" data-note="example data-lazurio-shell=page" lang="cs">',
  );
  for (const own of [
    "<html data-lazurio-shell=page>",
    "<html lang=cs DATA-LAZURIO-SHELL = 'page'>",
    "<html data-lazurio-shell>",
  ])
    expect(devFrameHtml(`${own}<body></body></html>`, {}, DEV)).toContain(own);
  // A page's own data-lazurio-shell stays.
  const own = page.replace("<html", '<html data-lazurio-shell="page"');
  expect(devFrameHtml(own, {}, DEV)).toContain(
    '<html data-lazurio-shell="page" lang="cs">',
  );
});

test("valid language tags with several subtags are taken; anything else is refused", () => {
  for (const lang of [
    "cs",
    "en-US",
    "zh-Hant-TW",
    "en-US-u-hc-h12",
    "sr-Latn-RS",
    "x-private",
    "i-klingon",
    "zh-min-nan",
    "en-GB-oed",
    "de-CH-1996",
    "es-419",
    "zh-yue-HK",
    "en-a-bbb-x-a-ccc",
  ])
    expect(
      viteDevFramePlugin({ lang }, DEV).transformIndexHtml.handler(page),
    ).toContain(`<lazurio-buddy version="dev" lang="${lang}">`);
  for (const lang of [
    'cs" x="y',
    "c",
    "en--US",
    "-cs",
    "toolongtag9",
    "en-x",
    "i-unknown",
    "de-a",
  ])
    expect(() => viteDevFramePlugin({ lang }, DEV)).toThrow(ModuleKitError);
});

test("a shell script elsewhere than https or the loopback is refused", () => {
  for (const script of [
    "http://example.com/shell.js",
    "javascript:alert(1)",
    'https://x.test/a" onload="x',
    "/.lazurio/shell.js",
  ])
    expect(() =>
      bunDevFramePlugin({}, { LAZURIO_RUNTIME_SHELL_SCRIPT: script }),
    ).toThrow(ModuleKitError);
  for (const script of [
    "https://launchpad.example.test/.lazurio/shell.js",
    "http://localhost:4174/.lazurio/shell.js",
    "http://[::1]:20000/.lazurio/shell.js",
  ])
    expect(() =>
      bunDevFramePlugin({}, { LAZURIO_RUNTIME_SHELL_SCRIPT: script }),
    ).not.toThrow();
});

test("bunDevFramePlugin hands the framed page to Bun's HTML loader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "module-kit-frame-"));
  const file = join(dir, "index.html");
  await writeFile(file, page);
  let loaded: { contents: string; loader: string } | undefined;
  bunDevFramePlugin({}, DEV).setup({
    onLoad: (constraints, callback) => {
      expect(constraints.filter.test("x/index.html")).toBe(true);
      expect(constraints.filter.test("x/main.ts")).toBe(false);
      void callback({ path: file }).then((result) => {
        loaded = result;
      });
    },
  });
  await Bun.sleep(20);
  expect(loaded?.loader).toBe("html");
  expect(loaded?.contents).toContain(`${INSERTED}</body>`);
  await rm(dir, { recursive: true, force: true });
});
