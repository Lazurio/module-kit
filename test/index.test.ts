import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  allowedHosts,
  astroServerOptions,
  health,
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
