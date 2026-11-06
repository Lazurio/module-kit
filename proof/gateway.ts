// Proof through the real gateway: the Lazurio workspace gateway (Machines'
// workspaceIngress rendered into a Caddyfile, run by the pinned Caddy) in
// front of two Apps, one reading `appAccess` (TypeScript) and one reading
// `app_access` (Python). It shows that a request through the gateway, with
// the App's hostname in any letter case, with a port or a trailing dot,
// counts only by the gateway's statement: a person is `environment`/admin, an
// admitted session without a person is `unknown`, a client's forged statement
// never counts, and no such request is ever `local`.
//
//   bun proof/gateway.ts <Machines checkout>   (CADDY_BIN, default `caddy`)
//
// Not part of `bun test`: it needs a Machines checkout, Caddy, OpenSSL and uv.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appAccess } from "../src/index.ts";

const machines = process.argv[2];
if (!machines)
  throw new Error("usage: bun proof/gateway.ts <Machines checkout>");
const caddy = process.env.CADDY_BIN ?? "caddy";
const kit = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "module-kit-gateway-"));
const DOMAIN = "pilot.example.lazurio.io";
const ALENA = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const children: ReturnType<typeof spawn>[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
const fail = (message: string): never => {
  throw new Error(message);
};

try {
  const [auth, launchpad, tsPort, pyPort, https] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const cert = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=*.${DOMAIN}`,
    "-addext",
    `subjectAltName=DNS:*.${DOMAIN}`,
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  if (cert.status !== 0) fail(`openssl: ${cert.stderr}`);

  // Stand-in oauth2-proxy /oauth2/auth: `alena` is a person, `nobody` an
  // admitted session whose answer names no person, anything else refused.
  Bun.serve({
    hostname: "127.0.0.1",
    port: auth,
    fetch(request) {
      const session = /__Secure-lazurio-workspace=([a-z]+)/.exec(
        request.headers.get("cookie") ?? "",
      )?.[1];
      if (session === "alena")
        return new Response(null, {
          status: 202,
          headers: {
            "X-Auth-Request-User": ALENA,
            "X-Auth-Request-Preferred-Username": "alena",
          },
        });
      if (session === "nobody") return new Response(null, { status: 202 });
      return new Response(null, { status: 401 });
    },
  });
  // Stand-in Launchpad: every module is ready.
  Bun.serve({
    hostname: "127.0.0.1",
    port: launchpad,
    fetch: () => new Response(null, { status: 204 }),
  });

  const origin = (slug: string) => `https://${slug}.${DOMAIN}`;
  // The TypeScript App.
  const tsEnv = {
    LAZURIO_RUNTIME_LISTENER_APP_HOST: "127.0.0.1",
    LAZURIO_RUNTIME_LISTENER_APP_PORT: String(tsPort),
    LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN: origin("ts"),
  };
  let reached = 0;
  Bun.serve({
    hostname: "127.0.0.1",
    port: tsPort,
    fetch(request) {
      reached++;
      return Response.json(appAccess(request, "app", tsEnv));
    },
  });
  // The Python App: the request's header pairs as sent, repeats included.
  const python = `
import dataclasses, json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from lazurio_module_kit import app_access
class Pairs:
    def __init__(self, pairs): self.pairs = pairs
    def items(self): return self.pairs
env = {"LAZURIO_RUNTIME_LISTENER_APP_HOST": "127.0.0.1", "LAZURIO_RUNTIME_LISTENER_APP_PORT": sys.argv[1],
       "LAZURIO_RUNTIME_LISTENER_APP_EXTERNAL_ORIGIN": sys.argv[2]}
class App(BaseHTTPRequestHandler):
    def do_GET(self):
        answer = dataclasses.asdict(app_access(Pairs(list(self.headers.items())), "app", env))
        body = json.dumps(answer).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), App).serve_forever()
`;
  children.push(
    spawn(
      "uv",
      [
        "run",
        "--project",
        join(kit, "python"),
        "python",
        "-c",
        python,
        String(pyPort),
        origin("py"),
      ],
      { stdio: "inherit" },
    ),
  );

  const { workspaceIngress } = (await import(
    join(machines, "workloads/workspace-vm/ingress.ts")
  )) as { workspaceIngress: (config: unknown, options?: unknown) => string };
  let caddyfile = workspaceIngress(
    {
      machine: "pilot",
      organization: "example",
      applications: [{ slug: "launchpad", port: launchpad }],
    },
    { authPort: auth },
  );
  caddyfile = caddyfile
    .replace(
      /admin unix\/\S+/,
      `admin off\n  https_port ${https}\n  http_port ${await freePort()}\n  auto_https disable_certs\n  storage file_system ${join(dir, "data")}`,
    )
    .replace(":443 {", `:${https} {`)
    .replaceAll(
      "tls /run/lazurio/tls/cert.pem /run/lazurio/tls/key.pem",
      `tls ${join(dir, "cert.pem")} ${join(dir, "key.pem")}`,
    )
    .replace(/^import \/etc\S*\n/m, "")
    .replace(
      /# BEGIN local entry[\s\S]*?# END local entry of the Environment browser\n/g,
      "",
    );
  caddyfile += `\nimport lazurio_module ts.${DOMAIN} 127.0.0.1:${tsPort} ts\nimport lazurio_module py.${DOMAIN} 127.0.0.1:${pyPort} py\n`;
  writeFileSync(join(dir, "Caddyfile"), caddyfile);
  children.push(
    spawn(
      caddy,
      ["run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"],
      {
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CONFIG_HOME: join(dir, "config"),
        },
      },
    ),
  );

  // Asynchronous: the TypeScript App answers from this very process.
  const get = async (slug: string, host: string, cookie: string | null) => {
    const name = `${slug}.${DOMAIN}`;
    const args = [
      "-sk",
      "--max-time",
      "10",
      "--resolve",
      `${name}:${https}:127.0.0.1`,
      "-H",
      `Host: ${host}`,
      "-H",
      "Sec-Fetch-Mode: navigate",
      // A client's own statement: the gateway removes it.
      "-H",
      "X-Auth-Request-User: 0b6f1c2e-6d3a-4f5b-9c8d-7e6f5a4b3c2d",
      "-H",
      "X-Lazurio-Entry: app",
      "-H",
      "X-Lazurio-App-Role: admin",
      ...(cookie ? ["-H", `Cookie: __Secure-lazurio-workspace=${cookie}`] : []),
      "-w",
      "\n%{http_code}",
      `https://${name}:${https}/`,
    ];
    const curl = Bun.spawn(["curl", ...args], { stdout: "pipe" });
    const out = await new Response(curl.stdout).text();
    await curl.exited;
    const cut = out.lastIndexOf("\n");
    return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
  };
  // Wait for Caddy and the Python App.
  for (let i = 0; ; i++) {
    if (
      (await get("py", `py.${DOMAIN}`, "alena")).status === 200 &&
      (await get("ts", `ts.${DOMAIN}`, "alena")).status === 200
    )
      break;
    if (i > 100) fail("the gateway or an App did not come up");
    await Bun.sleep(200);
  }

  const results: string[] = [];
  for (const slug of ["ts", "py"]) {
    const name = `${slug}.${DOMAIN}`;
    for (const host of [
      name,
      name.toUpperCase(),
      `${name}:443`,
      `${name}:${https}`,
      `${name}.`,
      `${name.toUpperCase()}.:443`,
    ]) {
      const before = reached;
      const first = await get(slug, host, "alena");
      if (first.status !== 200) {
        // The gateway answers itself (Caddy refuses a Host that does not
        // match the TLS name, 421): the App is never reached.
        if (first.status === 200 || (slug === "ts" && reached !== before))
          fail(
            `${slug} ${host}: refused with ${first.status} yet reached the App`,
          );
        results.push(
          `${slug} ${host}: refused by the gateway (${first.status})`,
        );
        continue;
      }
      const person = JSON.parse(first.body);
      const role = slug === "ts" ? person.appRole : person.app_role;
      if (
        person.entry !== "environment" ||
        role !== "admin" ||
        person.person?.subject !== ALENA ||
        person.source !== "gateway"
      )
        fail(
          `${slug} ${host}: a person through the gateway reads ${JSON.stringify(person)}`,
        );
      const second = await get(slug, host, "nobody");
      if (second.status !== 200)
        fail(
          `${slug} ${host}: a session without a person got ${second.status}`,
        );
      const nobody = JSON.parse(second.body);
      const none = slug === "ts" ? nobody.appRole : nobody.app_role;
      if (
        nobody.entry !== "unknown" ||
        none !== null ||
        nobody.reason !== "no-identity"
      )
        fail(
          `${slug} ${host}: a session without a person reads ${JSON.stringify(nobody)}`,
        );
      const counted = reached;
      const refused = await get(slug, host, null);
      if (refused.status === 200 || (slug === "ts" && reached !== counted))
        fail(
          `${slug} ${host}: a request without a session reached the App (${refused.status})`,
        );
      results.push(
        `${slug} ${host}: environment/admin with a person, unknown without one, refused without a session`,
      );
    }
  }
  console.log(results.join("\n"));
  console.log(
    `PASS: through the real gateway (${caddy}), for ${results.length} Host forms of a TypeScript and a Python App: a person is environment/admin from the gateway's answer, an admitted session without a person is unknown with no role, a client's forged statement never counts, no request is local, and without a session nothing reaches the App`,
  );
} finally {
  for (const child of children) child.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
