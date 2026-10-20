// Entry point for running the egress proxy as its own service (container or host process).
import { adminServer, EgressProxy } from "./proxy.js";

const token = process.env.SHIRA_EGRESS_ADMIN_TOKEN;
if (!token || token.length < 24) {
  console.error("SHIRA_EGRESS_ADMIN_TOKEN must be set (24+ characters)");
  process.exit(1);
}
const proxyPort = Number(process.env.SHIRA_EGRESS_PORT ?? 3128);
const adminPort = Number(process.env.SHIRA_EGRESS_ADMIN_PORT ?? 8080);
// Bind admin to an interface sandboxes can't reach where the deployment allows it; the
// bearer token protects it either way.
const adminHost = process.env.SHIRA_EGRESS_ADMIN_HOST ?? "0.0.0.0";

const proxy = new EgressProxy();
await proxy.listen(proxyPort);
adminServer(proxy, token).listen(adminPort, adminHost);
console.log(JSON.stringify({ event: "egress_proxy_started", proxyPort, adminPort, adminHost }));

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => proxy.close().then(() => process.exit(0)));
