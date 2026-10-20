import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminServer, EgressAdminClient, EgressProxy, hostAllowed } from "../src/egress/proxy.js";

/** Sends CONNECT through the proxy and returns the status line, plus the socket if tunneled. */
function tunnel(proxyPort: number, target: string, auth?: string) {
  return new Promise<{ status: string; socket: ReturnType<typeof connect> }>((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      const header = auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`);
    });
    socket.once("data", (d) => resolve({ status: d.toString().split("\r\n")[0]!, socket }));
    socket.on("error", reject);
  });
}

describe("hostAllowed", () => {
  it("matches exact hosts and subdomain wildcards on 443 by default", () => {
    const allow = ["api.anthropic.com", "*.npmjs.org", "git.internal.example:8443"];
    expect(hostAllowed(allow, "api.anthropic.com", 443)).toBe(true);
    expect(hostAllowed(allow, "API.Anthropic.com", 443)).toBe(true);
    expect(hostAllowed(allow, "api.anthropic.com", 80)).toBe(false);
    expect(hostAllowed(allow, "evil-api.anthropic.com", 443)).toBe(false);
    expect(hostAllowed(allow, "registry.npmjs.org", 443)).toBe(true);
    expect(hostAllowed(allow, "npmjs.org", 443)).toBe(false);
    expect(hostAllowed(allow, "npmjs.org.evil.com", 443)).toBe(false);
    expect(hostAllowed(allow, "git.internal.example", 8443)).toBe(true);
  });
});

describe("EgressProxy", () => {
  let echo: Server;
  let echoPort: number;
  let proxy: EgressProxy;
  let proxyPort: number;
  const events: { event: string; fields: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    echo = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, r)); // all interfaces: localhost may resolve to ::1
    echoPort = (echo.address() as AddressInfo).port;
    events.length = 0;
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise((r) => echo.close(r));
  });

  const start = async (allowPrivateTargets: boolean) => {
    proxy = new EgressProxy({ allowPrivateTargets, log: (event, fields) => events.push({ event, fields }) });
    proxyPort = (await proxy.listen(0, "127.0.0.1")).port;
    await proxy.grant("sbx1", "s3cret-s3cret-s3cret", [`localhost:${echoPort}`]);
  };

  it("tunnels to an allowlisted host for the right credentials", async () => {
    await start(true);
    const { status, socket } = await tunnel(proxyPort, `localhost:${echoPort}`, "sbx1:s3cret-s3cret-s3cret");
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const reply = new Promise<string>((r) => socket.once("data", (d) => r(d.toString())));
    socket.write("ping");
    expect(await reply).toBe("ping");
    socket.destroy();
    expect(events.at(-1)).toMatchObject({ event: "egress_allowed", fields: { sandbox: "sbx1" } });
  });

  it("rejects missing or wrong credentials, and revoked sandboxes", async () => {
    await start(true);
    expect((await tunnel(proxyPort, `localhost:${echoPort}`)).status).toMatch(/^HTTP\/1.1 407/);
    expect((await tunnel(proxyPort, `localhost:${echoPort}`, "sbx1:wrong-wrong-wrong-xx")).status).toMatch(/^HTTP\/1.1 407/);
    await proxy.revoke("sbx1");
    expect((await tunnel(proxyPort, `localhost:${echoPort}`, "sbx1:s3cret-s3cret-s3cret")).status).toMatch(/^HTTP\/1.1 407/);
  });

  /** Sends one CONNECT on an open socket and resolves with the status line. */
  const connectOn = (socket: ReturnType<typeof connect>, target: string, auth?: string) =>
    new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString().split("\r\n")[0]!));
      const header = auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`);
    });

  it("lets a client answer the 407 challenge on the same connection", async () => {
    await start(true);
    const first = await tunnel(proxyPort, `localhost:${echoPort}`);
    expect(first.status).toMatch(/^HTTP\/1.1 407/);
    // The connection stays open; the client retries with credentials, as git does by default.
    expect(await connectOn(first.socket, `localhost:${echoPort}`, "sbx1:s3cret-s3cret-s3cret")).toBe("HTTP/1.1 200 Connection Established");
    const reply = new Promise<string>((r) => first.socket.once("data", (d) => r(d.toString())));
    first.socket.write("ping");
    expect(await reply).toBe("ping");
    first.socket.destroy();
  });

  it("still applies the allowlist after a challenge", async () => {
    await start(true);
    const first = await tunnel(proxyPort, "example.com:443");
    expect(await connectOn(first.socket, "example.com:443", "sbx1:s3cret-s3cret-s3cret")).toMatch(/^HTTP\/1.1 403/);
  });

  it("gives up after repeated failed challenges", async () => {
    await start(true);
    const first = await tunnel(proxyPort, `localhost:${echoPort}`);
    expect(await connectOn(first.socket, `localhost:${echoPort}`, "sbx1:wrong-wrong-wrong-xx")).toMatch(/^HTTP\/1.1 407/);
    const closed = new Promise((r) => first.socket.once("close", r));
    expect(await connectOn(first.socket, `localhost:${echoPort}`, "sbx1:still-wrong-wrong-x")).toMatch(/^HTTP\/1.1 407/);
    await closed; // third strike: the proxy closes the connection
  });

  it("closes the connection if the follow-up isn't a CONNECT", async () => {
    await start(true);
    const first = await tunnel(proxyPort, `localhost:${echoPort}`);
    const closed = new Promise((r) => first.socket.once("close", r));
    first.socket.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    await closed;
    expect(events.at(-1)).toMatchObject({ event: "egress_denied", fields: { reason: "unauthenticated" } });
  });

  it("rejects hosts outside the sandbox's allowlist", async () => {
    await start(true);
    const { status } = await tunnel(proxyPort, "example.com:443", "sbx1:s3cret-s3cret-s3cret");
    expect(status).toMatch(/^HTTP\/1.1 403/);
    expect(events.at(-1)).toMatchObject({ event: "egress_denied", fields: { reason: "not_allowlisted" } });
  });

  it("never connects to private addresses, even when allowlisted", async () => {
    await start(false);
    const { status } = await tunnel(proxyPort, `localhost:${echoPort}`, "sbx1:s3cret-s3cret-s3cret");
    expect(status).toMatch(/^HTTP\/1.1 403/);
    expect(events.at(-1)).toMatchObject({ event: "egress_denied", fields: { reason: "private_address" } });
    await proxy.grant("sbx2", "s3cret-s3cret-s3cret", ["169.254.169.254:80"]);
    expect((await tunnel(proxyPort, "169.254.169.254:80", "sbx2:s3cret-s3cret-s3cret")).status).toMatch(/^HTTP\/1.1 403/);
  });

  it("answers 502 when the upstream refuses the connection", async () => {
    await start(true);
    await proxy.grant("sbx4", "s3cret-s3cret-s3cret", ["127.0.0.1:1"]);
    expect((await tunnel(proxyPort, "127.0.0.1:1", "sbx4:s3cret-s3cret-s3cret")).status).toBe("HTTP/1.1 502 Bad Gateway");
  });

  it("refuses plain HTTP", async () => {
    await start(true);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/http://example.com/`);
    expect(res.status).toBe(405);
  });

  it("is managed through the admin API with a bearer token", async () => {
    await start(true);
    const admin = adminServer(proxy, "t".repeat(32));
    await new Promise<void>((r) => admin.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
    try {
      await expect(new EgressAdminClient(url, "wrong").grant("sbx3", "x".repeat(20), [])).rejects.toThrow(/401/);
      const client = new EgressAdminClient(url, "t".repeat(32));
      await client.grant("sbx3", "x".repeat(20), [`localhost:${echoPort}`]);
      const open = await tunnel(proxyPort, `localhost:${echoPort}`, `sbx3:${"x".repeat(20)}`);
      expect(open.status).toMatch(/200/);
      const closed = new Promise((r) => open.socket.once("close", r));
      await client.revoke("sbx3");
      await closed; // revoking cuts tunnels the sandbox already had
      expect((await tunnel(proxyPort, `localhost:${echoPort}`, `sbx3:${"x".repeat(20)}`)).status).toMatch(/407/);
    } finally {
      admin.close();
    }
  });
});
