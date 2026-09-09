/**
 * OPERON FORK TEST — `KANEO_WEBHOOK_DESTINATION_ALLOWLIST` (Operon spec R23, G7).
 *
 * A separate file rather than more cases in
 * `tests/api/utils/assert-public-destination.test.ts`: that file is upstream's
 * and is byte-identical to `v2.23.1`, and keeping it that way is one fewer
 * conflict at the next merge. Everything Operon adds to this module is here.
 *
 * NO NETWORK. Every private case throws before `dns.lookup` is reached, and the
 * one routable case uses an IP literal, which `dns.lookup` answers from the
 * string itself. A unit suite that needed DNS would fail on an aeroplane and
 * pass in CI, which is the worst of both.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPublicDestination,
  isAllowlistedDestination,
} from "../../../apps/api/src/utils/assert-public-destination";

const ALLOWLIST = "KANEO_WEBHOOK_DESTINATION_ALLOWLIST";
const LEGACY = "KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS";

let savedAllowlist: string | undefined;
let savedLegacy: string | undefined;

beforeEach(() => {
  savedAllowlist = process.env[ALLOWLIST];
  savedLegacy = process.env[LEGACY];
  delete process.env[ALLOWLIST];
  delete process.env[LEGACY];
});

afterEach(() => {
  if (savedAllowlist === undefined) delete process.env[ALLOWLIST];
  else process.env[ALLOWLIST] = savedAllowlist;
  if (savedLegacy === undefined) delete process.env[LEGACY];
  else process.env[LEGACY] = savedLegacy;
});

describe("isAllowlistedDestination", () => {
  it("matches an exact host:port and nothing that merely resembles it", () => {
    process.env[ALLOWLIST] = "platform-service:3001";

    expect(
      isAllowlistedDestination(
        new URL("http://platform-service:3001/webhooks/kaneo"),
      ),
    ).toBe(true);
    // A different port on the same host is a different destination.
    expect(
      isAllowlistedDestination(
        new URL("http://platform-service:3002/webhooks/kaneo"),
      ),
    ).toBe(false);
    // No suffix rule: this is the case a `endsWith` implementation would admit.
    expect(
      isAllowlistedDestination(new URL("http://evil-platform-service:3001/")),
    ).toBe(false);
    // No prefix rule either.
    expect(
      isAllowlistedDestination(
        new URL("http://platform-service.evil.test:3001/"),
      ),
    ).toBe(false);
  });

  // The bare form has to mean "any port" to mean anything: `URL.host` omits a
  // default port, so `platform-service:80` could never match
  // `http://platform-service/` and the default-port case would be unwritable in
  // the other spelling. The host is still matched exactly.
  it("matches a bare host on any port, and still only that host", () => {
    process.env[ALLOWLIST] = "platform-service";

    expect(
      isAllowlistedDestination(new URL("http://platform-service/hook")),
    ).toBe(true);
    expect(
      isAllowlistedDestination(new URL("https://platform-service/hook")),
    ).toBe(true);
    expect(
      isAllowlistedDestination(new URL("http://platform-service:3001/hook")),
    ).toBe(true);
    expect(
      isAllowlistedDestination(new URL("http://evil-platform-service/hook")),
    ).toBe(false);
    expect(
      isAllowlistedDestination(new URL("http://platform-service.evil.test/")),
    ).toBe(false);
  });

  it("folds case, and tolerates whitespace and empty entries in the list", () => {
    process.env[ALLOWLIST] = " , PLATFORM-Service:3001 ,, ";

    expect(
      isAllowlistedDestination(new URL("http://Platform-Service:3001/")),
    ).toBe(true);
  });

  it("admits nothing when the list is unset, empty or only separators", () => {
    for (const value of [undefined, "", "   ", ",,,"]) {
      if (value === undefined) delete process.env[ALLOWLIST];
      else process.env[ALLOWLIST] = value;
      expect(
        isAllowlistedDestination(new URL("http://platform-service:3001/")),
      ).toBe(false);
    }
  });
});

describe("assertPublicDestination with an allowlist", () => {
  it("passes an allowlisted host:port that is otherwise a private destination", async () => {
    process.env[ALLOWLIST] = "10.1.2.3:8080";

    await expect(
      assertPublicDestination(
        "http://10.1.2.3:8080/webhooks/kaneo",
        "Generic webhook",
      ),
    ).resolves.toBeUndefined();
  });

  it("still refuses a neighbouring private address", async () => {
    process.env[ALLOWLIST] = "10.1.2.3:8080";

    // The neighbour on the same subnet.
    await expect(
      assertPublicDestination(
        "http://10.1.2.4:8080/webhooks/kaneo",
        "Generic webhook",
      ),
    ).rejects.toThrow(/non-routable/);
    // The same host on a port the deployment did not name.
    await expect(
      assertPublicDestination(
        "http://10.1.2.3:9090/webhooks/kaneo",
        "Generic webhook",
      ),
    ).rejects.toThrow(/non-routable/);
    // The bridge gateway and the metadata endpoint, which is what R23 is about.
    await expect(
      assertPublicDestination(
        "http://172.17.0.1/webhooks/kaneo",
        "Generic webhook",
      ),
    ).rejects.toThrow(/non-routable/);
    await expect(
      assertPublicDestination(
        "http://169.254.169.254/latest/meta-data/",
        "Generic webhook",
      ),
    ).rejects.toThrow(/non-routable/);
  });

  it("refuses every private destination when the allowlist is empty", async () => {
    process.env[ALLOWLIST] = "";

    for (const destination of [
      "http://127.0.0.1/hook",
      "http://10.0.0.1/hook",
      "http://172.16.0.1/hook",
      "http://192.168.1.1/hook",
      "http://169.254.169.254/hook",
      "http://[::1]/hook",
    ]) {
      await expect(
        assertPublicDestination(destination, "Generic webhook"),
      ).rejects.toThrow(/non-routable/);
    }
  });

  it("leaves the legacy boolean short-circuiting where it is set", async () => {
    process.env[LEGACY] = "true";

    await expect(
      assertPublicDestination(
        "http://172.16.0.1/webhooks/kaneo",
        "Generic webhook",
      ),
    ).resolves.toBeUndefined();

    process.env[LEGACY] = "1";
    await expect(
      assertPublicDestination(
        "http://10.0.0.1/webhooks/kaneo",
        "Generic webhook",
      ),
    ).resolves.toBeUndefined();
  });

  it("leaves a routable destination unaffected, allowlist or no allowlist", async () => {
    await expect(
      assertPublicDestination("http://93.184.216.34/hook", "Generic webhook"),
    ).resolves.toBeUndefined();

    process.env[ALLOWLIST] = "platform-service:3001";
    await expect(
      assertPublicDestination("http://93.184.216.34/hook", "Generic webhook"),
    ).resolves.toBeUndefined();
  });

  it("does not let an allowlist entry smuggle a non-http scheme past the protocol check", async () => {
    process.env[ALLOWLIST] = "platform-service:3001";

    await expect(
      assertPublicDestination(
        "ftp://platform-service:3001/hook",
        "Generic webhook",
      ),
    ).rejects.toThrow(/must use http or https/);
  });
});
