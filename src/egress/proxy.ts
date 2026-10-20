import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type AddressInfo, type Socket } from "node:net";

/** Grants egress for one sandbox. Implemented by the proxy itself and by its admin API client. */
export interface EgressGrants {
  grant(sandboxId: string, secret: string, hosts: readonly string[]): Promise<void>;
  revoke(sandboxId: string): Promise<void>;
}

/**
 * Addresses a sandbox may never reach, whatever its allowlist says: loopback, private
 * networks, link-local (including the cloud metadata endpoint 169.254.169.254, which
 * hands out instance credentials), and carrier-grade NAT.
 */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

function isPrivate(address: string): boolean {
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  return PRIVATE.check(mapped, isIP(mapped) === 6 ? "ipv6" : "ipv4");
}

/** `example.com` matches exactly; `*.example.com` matches subdomains only. Port 443 unless given. */
export function hostAllowed(patterns: readonly string[], host: string, port: number): boolean {
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    const [pattern, p] = raw.toLowerCase().split(":") as [string, string | undefined];
    if (port !== (p ? Number(p) : 443)) return false;
    return pattern.startsWith("*.") ? h.endsWith(pattern.slice(1)) : h === pattern;
  });
}

interface Grant {
  secret: Buffer;
  hosts: readonly string[];
}

export interface EgressProxyOptions {
  /** Allow private and loopback targets. Tests only. */
  allowPrivateTargets?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * The only way out of a sandbox (FR-E4). Sandboxes sit on a network with no route to
 * the internet and reach this proxy with their own credentials. It tunnels HTTPS
 * (CONNECT) to hosts on that sandbox's allowlist and refuses everything else,
 * including plain HTTP and private addresses. Every decision is logged.
 */
export class EgressProxy implements EgressGrants {
  private readonly grants = new Map<string, Grant>();
  /** Open tunnels per sandbox, so revoking a sandbox also cuts connections it already has. */
  private readonly tunnels = new Map<string, Set<Socket>>();
  private readonly log: NonNullable<EgressProxyOptions["log"]>;
  readonly server: Server;

  constructor(private readonly opts: EgressProxyOptions = {}) {
    this.log = opts.log ?? ((e, f) => console.log(JSON.stringify({ at: new Date().toISOString(), event: e, ...f })));
    this.server = createServer((req, res) => {
      res.writeHead(405, { "content-type": "text/plain" }).end("only HTTPS (CONNECT) is allowed\n");
      this.log("egress_denied", { reason: "plain_http", url: req.url });
    });
    this.server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
      this.tunnel(req, client, head).catch((err) => {
        this.log("egress_error", { error: (err as Error).message });
        client.destroy();
      });
    });
  }

  async grant(sandboxId: string, secret: string, hosts: readonly string[]): Promise<void> {
    this.grants.set(sandboxId, { secret: Buffer.from(secret), hosts: [...hosts] });
  }

  async revoke(sandboxId: string): Promise<void> {
    this.grants.delete(sandboxId);
    for (const s of this.tunnels.get(sandboxId) ?? []) s.destroy();
    this.tunnels.delete(sandboxId);
  }

  listen(port: number, host = "0.0.0.0"): Promise<AddressInfo> {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address() as AddressInfo)));
  }

  close(): Promise<void> {
    for (const set of this.tunnels.values()) for (const s of set) s.destroy();
    this.tunnels.clear();
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private authenticate(req: IncomingMessage): { id: string; grant: Grant } | null {
    const header = req.headers["proxy-authorization"];
    if (!header?.startsWith("Basic ")) return null;
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const sep = decoded.indexOf(":");
    const id = decoded.slice(0, sep);
    const secret = Buffer.from(decoded.slice(sep + 1));
    const grant = this.grants.get(id);
    if (!grant || grant.secret.length !== secret.length || !timingSafeEqual(grant.secret, secret)) return null;
    return { id, grant };
  }

  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const deny = (status: string, reason: string, fields: Record<string, unknown> = {}) => {
      this.log("egress_denied", { reason, target: req.url, ...fields });
      client.end(`HTTP/1.1 ${status}\r\nProxy-Authenticate: Basic realm="shira"\r\n\r\n`);
    };

    const auth = this.authenticate(req);
    if (!auth) return deny("407 Proxy Authentication Required", "unauthenticated");

    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "");
    if (!m) return deny("400 Bad Request", "bad_target", { sandbox: auth.id });
    const [, host, portText] = m as unknown as [string, string, string];
    const port = Number(portText);
    if (!hostAllowed(auth.grant.hosts, host, port)) return deny("403 Forbidden", "not_allowlisted", { sandbox: auth.id });

    // Resolve once and connect to that address, so DNS can't point an allowed name at
    // a private address between the check and the connection.
    const { address } = isIP(host) ? { address: host } : await lookup(host);
    if (!this.opts.allowPrivateTargets && isPrivate(address)) {
      return deny("403 Forbidden", "private_address", { sandbox: auth.id, address });
    }

    let established = false;
    const upstream = connect(port, address, () => {
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      this.log("egress_allowed", { sandbox: auth.id, target: `${host}:${port}`, address });
    });
    const open = this.tunnels.get(auth.id) ?? new Set<Socket>();
    this.tunnels.set(auth.id, open.add(client).add(upstream));
    const forget = () => {
      open.delete(client);
      open.delete(upstream);
    };
    client.on("close", forget);
    upstream.on("close", forget);
    upstream.on("error", (err) => {
      if (established) return client.destroy();
      this.log("egress_error", { sandbox: auth.id, target: `${host}:${port}`, error: err.message });
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    client.on("error", () => upstream.destroy());
  }
}

/**
 * Admin API so dispatchers can grant and revoke sandboxes on a proxy running as its own
 * service. It must listen on a network sandboxes can't reach.
 */
export function adminServer(proxy: EgressGrants, token: string): Server {
  const expected = Buffer.from(`Bearer ${token}`);
  const send = (res: ServerResponse, status: number, body?: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(body ? JSON.stringify(body) : undefined);

  return createServer(async (req, res) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return send(res, 401, { error: "unauthorized" });
    const m = /^\/grants\/([\w-]+)$/.exec(req.url ?? "");
    if (!m) return send(res, 404, { error: "not found" });
    const id = m[1]!;
    if (req.method === "DELETE") {
      await proxy.revoke(id);
      return send(res, 204);
    }
    if (req.method !== "PUT") return send(res, 405, { error: "method not allowed" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const { secret, hosts } = JSON.parse(raw) as { secret?: unknown; hosts?: unknown };
      if (typeof secret !== "string" || secret.length < 16 || !Array.isArray(hosts) || !hosts.every((h) => typeof h === "string")) {
        return send(res, 400, { error: "need secret (16+ chars) and hosts (string[])" });
      }
      await proxy.grant(id, secret, hosts);
      return send(res, 204);
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
  });
}

/** Client for a proxy's admin API. */
export class EgressAdminClient implements EgressGrants {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async call(method: string, id: string, body?: unknown): Promise<void> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/grants/${id}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`egress admin ${method} ${id} failed: ${res.status} ${await res.text()}`);
  }

  grant(sandboxId: string, secret: string, hosts: readonly string[]) {
    return this.call("PUT", sandboxId, { secret, hosts });
  }

  revoke(sandboxId: string) {
    return this.call("DELETE", sandboxId);
  }
}
