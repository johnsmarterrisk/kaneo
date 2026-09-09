import { lookup } from "node:dns/promises";
import net from "node:net";

function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return true;
  }

  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    // 100.64.0.0/10, RFC 6598. Several hosted Kubernetes offerings put pod
    // and service networks in here, where it reaches the same neighbours
    // 10/8 does on a plain VPC.
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// ::ffff:127.0.0.1 is an IPv4 destination wearing an IPv6 shape, and the URL
// parser rewrites it to the hex form ::ffff:7f00:1, so both must be unwrapped.
function mappedIpv4(ip: string): string | null {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return dotted[1];

  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) return null;

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isDisallowedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  const mapped = mappedIpv4(normalized);
  if (mapped) {
    return isDisallowedIpv4(mapped);
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}

export function isDisallowedAddress(address: string): boolean {
  // URL.hostname keeps the brackets on IPv6 literals, and net.isIP rejects
  // those, which would let http://[::1] slip past the checks below.
  const bare = address.replace(/^\[|\]$/g, "");

  if (bare === "localhost") {
    return true;
  }

  const version = net.isIP(bare);
  if (version === 4) {
    return isDisallowedIpv4(bare);
  }

  if (version === 6) {
    return isDisallowedIpv6(bare);
  }

  return false;
}

function privateDestinationsAllowed(): boolean {
  return (
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS === "true" ||
    process.env.KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS === "1"
  );
}

// ── OPERON FORK CHANGE — the private-destination allowlist ───────────────────
//
// `KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS` is a FULL short-circuit: set, it
// returns from `assertPublicDestination` before a single address is examined,
// so every private range this file exists to refuse — the bridge gateway, a
// neighbouring container, `169.254.169.254` — becomes reachable by anyone who
// can save a generic-webhook or Gitea URL. That is tolerable on a workstation
// bound to loopback and it is not tolerable on a shared public host.
//
// Turning the boolean off alone is not the fix, because Operon's own Telegraph
// receiver lives at `http://platform-service:3001`, which resolves into
// `172.16.0.0/12` — the Docker bridge range `isDisallowedIpv4` refuses — so the
// signal pipeline would go down rather than get harder to abuse.
//
// So the deployment names the ONE private destination it means to permit and
// nothing else. `KANEO_WEBHOOK_DESTINATION_ALLOWLIST` is a comma-separated list
// of exact `host` or `host:port` values, consulted BEFORE the address rules and
// AFTER the protocol check, and it is what replaces the boolean in production.
// The boolean is left exactly as upstream wrote it and still short-circuits
// where it is set, because the local stack sets it and a fork change must not
// break the local stack.
//
// Matching is EXACT on the host and is never a suffix, a prefix or a range. A
// suffix rule is how an allowlist becomes an open door — `platform-service` as
// a suffix would admit `evil-platform-service` — and a range would re-admit the
// neighbours the address rules exist to keep out. The two spellings differ only
// in how much of the destination they pin: `host:port` admits that host on that
// port and no other, while a bare `host` admits that host on ANY port. The bare
// form has to mean "any port" to mean anything at all, because `URL.host` omits
// a default port — `platform-service:80` would never match `http://platform-service/`
// — so a bare entry that pinned the default port would be unwritable in the
// other form and would leave "this host, any port" inexpressible. Production
// therefore uses the `host:port` form. Comparison is case-folded, hostnames
// being case-insensitive.

function destinationAllowlist(): string[] {
  return String(process.env.KANEO_WEBHOOK_DESTINATION_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

export function isAllowlistedDestination(url: URL): boolean {
  const entries = destinationAllowlist();
  if (entries.length === 0) {
    return false;
  }

  // `url.host` carries the port only when it is not the scheme's default and
  // `url.hostname` never carries one. Comparing an entry against BOTH is what
  // makes `host:port` port-exact and a bare `host` port-agnostic in one pass.
  // IPv6 literals keep their brackets in both, which is the spelling a URL
  // uses, so it is the spelling an entry must use too.
  const candidates = [url.host.toLowerCase(), url.hostname.toLowerCase()];

  return entries.some((entry) => candidates.includes(entry));
}

export async function assertPublicDestination(
  destinationUrl: string,
  label: string,
): Promise<void> {
  const url = new URL(destinationUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} URL must use http or https`);
  }

  // Consulted BEFORE the address rules and before the legacy boolean: it is the
  // production form of the same permission, narrowed to the exact destinations
  // the deployment names rather than to every private range at once.
  if (isAllowlistedDestination(url)) {
    return;
  }

  if (privateDestinationsAllowed()) {
    return;
  }

  if (isDisallowedAddress(url.hostname)) {
    throw new Error(`${label} destination resolves to a non-routable address`);
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`${label} destination could not be resolved`);
  }

  if (addresses.some((entry) => isDisallowedAddress(entry.address))) {
    throw new Error(`${label} destination resolves to a non-routable address`);
  }
}
