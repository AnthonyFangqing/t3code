/**
 * Tests for PiProvider — health check and model discovery.
 *
 * @module PiProvider.test
 */
import { describe, it, expect } from "vitest";
import * as Schema from "effect/Schema";
import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";

import { makePendingPiProvider, checkPiProviderStatus } from "./PiProvider.ts";
import * as Effect from "effect/Effect";

const PROVIDER = ProviderDriverKind.make("pi");

function defaultPiSettings(
  overrides: Partial<typeof PiSettings.Type> = {},
): typeof PiSettings.Type {
  return Schema.decodeSync(PiSettings)({
    enabled: true,
    ...overrides,
  });
}

describe("PiProvider", () => {
  describe("makePendingPiProvider", () => {
    it("returns disabled snapshot when disabled", async () => {
      const snapshot = await Effect.runPromise(makePendingPiProvider(defaultPiSettings({ enabled: false })));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    });

    it("returns pending snapshot when enabled but not yet checked", async () => {
      const snapshot = await Effect.runPromise(makePendingPiProvider(defaultPiSettings()));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("not been checked");
      expect(snapshot.models).toHaveLength(0);
    });
  });

  describe("checkPiProviderStatus", () => {
    it("returns a valid snapshot (requires pi packages installed)", async () => {
      const result = await Effect.runPromise(checkPiProviderStatus());
      // Just verify we get something back
      expect(result).toBeDefined();
      expect(typeof result.enabled).toBe("boolean");
    });
  });
});
