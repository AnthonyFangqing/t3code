/**
 * PiProvider — health check and model discovery for the Pi provider.
 *
 * Uses Pi's ModelRegistry for model discovery, loading extensions first
 * so that extension-registered model providers are included.
 *
 * @module PiProvider
 */
import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
  type PiSettings,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "thinkingLevel",
      label: "Thinking",
      type: "select" as const,
      options: [
        { id: "off", label: "Off" },
        { id: "minimal", label: "Minimal" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "X-High" },
      ],
    },
  ],
});

function flattenPiModels(models: ReadonlyArray<{ provider: string; id: string; name?: string }>): ReadonlyArray<ServerProviderModel> {
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const name = nonEmptyTrimmed(model.name ?? model.id);
    if (!name) continue;
    result.push({
      slug: `${model.provider}/${model.id}`,
      name,
      ...(model.provider ? { subProvider: nonEmptyTrimmed(model.provider) ?? undefined } : {}),
      isCustom: false,
      capabilities: DEFAULT_PI_MODEL_CAPABILITIES,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export const makePendingPiProvider = (
  piSettings: PiSettings,
): ServerProviderDraft => {
  const checkedAt = new Date().toISOString();

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Pi provider status has not been checked in this session yet.",
    },
  });
};

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = new Date().toISOString();

  const result = yield* Effect.exit(Effect.gen(function* () {
    const { ModelRegistry, AuthStorage, SettingsManager, DefaultResourceLoader, getAgentDir } =
      yield* Effect.tryPromise(() => import("@mariozechner/pi-coding-agent"));

    const agentDir = getAgentDir();
    const cwd = process.cwd();

    const authStorage = AuthStorage.create(undefined);
    const modelRegistry = ModelRegistry.create(authStorage, undefined);
    const settingsManager = SettingsManager.create(cwd, agentDir);

    // Load extensions so extension-registered model providers are included
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    yield* Effect.tryPromise(() => resourceLoader.reload());

    // Flush pending provider registrations from extensions (normally done by
    // ExtensionRunner.bindCore(), which only runs inside AgentSession)
    const extResult = resourceLoader.getExtensions();
    for (const { name, config } of extResult.runtime.pendingProviderRegistrations) {
      modelRegistry.registerProvider(name, config as unknown as Parameters<typeof modelRegistry.registerProvider>[1]);
    }

    const models = modelRegistry.getAvailable();

    let configuredCount = 0;
    for (const model of models) {
      const authResult = yield* Effect.tryPromise(() => modelRegistry.getApiKeyAndHeaders(model));
      if (authResult.ok) configuredCount += 1;
    }

    const serverModels = providerModelsFromSettings(
      flattenPiModels(models),
      PROVIDER,
      [],
      DEFAULT_PI_MODEL_CAPABILITIES,
    );

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: serverModels,
      probe: {
        installed: true,
        version: "0.72.1",
        status: configuredCount > 0 ? "ready" : "warning",
        auth: {
          status: configuredCount > 0 ? "authenticated" : "unknown",
          type: "pi",
        },
        message:
          configuredCount > 0
            ? `${configuredCount} Pi provider${configuredCount === 1 ? "" : "s"} available (${models.length} models total).`
            : `Pi is available but no providers have configured API keys. Run 'pi login' or configure API keys in ~/.pi/auth.json.`,
      },
    });
  }));

  if (result._tag === "Failure") {
    const message = `Failed to probe Pi: ${result.cause instanceof Error ? result.cause.message : String(result.cause)}`;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message,
      },
    });
  }

  return result.value;
});
