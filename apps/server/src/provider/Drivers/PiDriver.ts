/**
 * PiDriver — `ProviderDriver` for the Pi coding agent.
 *
 * Uses Pi's SDK in-process (no child process), matching the Claude adapter
 * architecture. Each instance can have multiple concurrent sessions (one per
 * t3code thread) within the same Node.js process.
 *
 * @module provider/Drivers/PiDriver
 */
import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, Schema, Stream } from "effect";

import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type PiDriverEnv = ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings as Schema.Codec<PiSettings, unknown>,
  defaultConfig: (): PiSettings => Schema.decodeSync(PiSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment: _environment, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;

      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        homePath: effectiveConfig.homePath || undefined,
        defaultProvider: effectiveConfig.defaultProvider || undefined,
        defaultModel: effectiveConfig.defaultModel || undefined,
      });
      const textGeneration = yield* makePiTextGeneration;

      const checkProvider = Effect.map(checkPiProviderStatus(), stampIdentity);

      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingPiProvider(settings)),
        checkProvider: checkProvider as Effect.Effect<ServerProvider, never, never>,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: snapshot as ProviderInstance["snapshot"],
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
