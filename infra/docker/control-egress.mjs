// Only the control proxy loads these exceptions. A runner cannot join its Docker network.
import { readFileSync } from "node:fs";

const rules = [];
// A remote worker's API may sit on a tailnet or LAN address that the forbidden ranges cover.
for (const [index, name] of [
  "SWIZZLE_ARTIFACT_S3_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "SWIZZLE_WORKER_API_URL",
].entries()) {
  const value = process.env[name]?.trim();
  if (!value) continue;
  let endpoint;
  try {
    endpoint = new URL(value);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hostname.startsWith(".") ||
      !/^[a-z0-9.:[\]-]+$/iu.test(endpoint.hostname)
    ) {
      throw new Error("Invalid endpoint");
    }
  } catch {
    console.error(`${name} must be an HTTP(S) URL without credentials.`);
    process.exit(1);
  }
  rules.push(
    `acl control_endpoint_${index} dstdomain -n ${endpoint.hostname}`,
    `acl control_port_${index} port ${endpoint.port || (endpoint.protocol === "https:" ? "443" : "80")}`,
    `http_access allow control_endpoint_${index} control_port_${index}`,
  );
}
const config = readFileSync("/etc/squid/squid.conf", "utf8");
process.stdout.write(
  config.replace(
    "http_access deny !Safe_ports",
    `${rules.join("\n")}\nhttp_access deny !Safe_ports`,
  ),
);
