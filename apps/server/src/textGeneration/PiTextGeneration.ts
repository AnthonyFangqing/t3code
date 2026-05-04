/**
 * PiTextGeneration — commit message, PR content, branch name, and thread
 * title generation using Pi's SDK.
 *
 * @module PiTextGeneration
 */
import { Effect, Schema } from "effect";

import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerConfig } from "../config.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

async function resolvePiTextModel(
  modelSelection: ModelSelection | undefined,
  agentDir: string,
): Promise<{ provider: string; id: string } | undefined> {
  const { ModelRegistry, AuthStorage } = await import("@mariozechner/pi-coding-agent");
  const authStorage = AuthStorage.create(undefined);
  const modelRegistry = ModelRegistry.create(authStorage, undefined);
  const models = await modelRegistry.getAvailable();

  // If a specific model is requested, try to find it
  if (modelSelection?.model) {
    const slash = modelSelection.model.indexOf("/");
    if (slash > 0 && slash < modelSelection.model.length - 1) {
      const provider = modelSelection.model.slice(0, slash);
      const modelId = modelSelection.model.slice(slash + 1);
      const found = models.find((m) => m.provider === provider && m.id === modelId);
      if (found) {
        const auth = await modelRegistry.getApiKeyAndHeaders(found);
        if (auth.ok) return found;
      }
    }
  }

  // Fall back to first available configured model
  for (const m of models) {
    const auth = await modelRegistry.getApiKeyAndHeaders(m);
    if (auth.ok) return m;
  }

  return undefined;
}

async function runPiPrompt(input: {
  cwd: string;
  prompt: string;
  agentDir: string;
  model: { provider: string; id: string } | undefined;
}): Promise<string> {
  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry, SettingsManager } = await import("@mariozechner/pi-coding-agent");

  const authStorage = AuthStorage.create(undefined);
  const modelRegistry = ModelRegistry.create(authStorage, undefined);
  const settingsManager = SettingsManager.create(input.cwd, input.agentDir);
  const sessionManager = SessionManager.inMemory();

  const models = await modelRegistry.getAvailable();
  let selectedModel = input.model
    ? models.find((m) => m.provider === input.model!.provider && m.id === input.model!.id)
    : undefined;

  if (!selectedModel) {
    for (const m of models) {
      const auth = await modelRegistry.getApiKeyAndHeaders(m);
      if (auth.ok) { selectedModel = m; break; }
    }
  }

  if (!selectedModel) {
    throw new Error("No Pi models with configured API keys. Run 'pi login' or configure auth.");
  }

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    model: selectedModel,
    tools: [],
    sessionStartEvent: { type: "session_start", reason: "new" },
  });

  const collectedText: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.message.role === "assistant") {
      const content: unknown = event.message.content;
      if (typeof content === "string") collectedText.push(content);
      else if (Array.isArray(content)) {
        for (const c of content as Array<{ type: string; text?: string }>) {
          if (c.type === "text" && c.text) collectedText.push(c.text);
        }
      }
    }
  });

  await session.prompt(input.prompt);
  await session.agent.waitForIdle();
  unsubscribe();
  session.dispose();

  return collectedText.join("");
}

export const makePiTextGeneration = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const agentDir = serverConfig.cwd;

  const generateCommitMessage = Effect.fn("PiTextGeneration.generateCommitMessage")(
    function* (input: Parameters<TextGenerationShape["generateCommitMessage"]>[0]) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const model = yield* Effect.promise(() =>
        resolvePiTextModel(input.modelSelection, agentDir),
      );

      const rawOutput = yield* Effect.tryPromise({
        try: () => runPiPrompt({ cwd: input.cwd, prompt, agentDir, model }),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateCommitMessage",
            detail: `Pi text generation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const generated = yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
        extractJsonObject(rawOutput),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Pi returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    },
  );

  const generatePrContent = Effect.fn("PiTextGeneration.generatePrContent")(
    function* (input: Parameters<TextGenerationShape["generatePrContent"]>[0]) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const model = yield* Effect.promise(() =>
        resolvePiTextModel(input.modelSelection, agentDir),
      );

      const rawOutput = yield* Effect.tryPromise({
        try: () => runPiPrompt({ cwd: input.cwd, prompt, agentDir, model }),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generatePrContent",
            detail: `Pi text generation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const generated = yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
        extractJsonObject(rawOutput),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Pi returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    },
  );

  const generateBranchName = Effect.fn("PiTextGeneration.generateBranchName")(
    function* (input: Parameters<TextGenerationShape["generateBranchName"]>[0]) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const model = yield* Effect.promise(() =>
        resolvePiTextModel(input.modelSelection, agentDir),
      );

      const rawOutput = yield* Effect.tryPromise({
        try: () => runPiPrompt({ cwd: input.cwd, prompt, agentDir, model }),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateBranchName",
            detail: `Pi text generation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const generated = yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
        extractJsonObject(rawOutput),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Pi returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    },
  );

  const generateThreadTitle = Effect.fn("PiTextGeneration.generateThreadTitle")(
    function* (input: Parameters<TextGenerationShape["generateThreadTitle"]>[0]) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const model = yield* Effect.promise(() =>
        resolvePiTextModel(input.modelSelection, agentDir),
      );

      const rawOutput = yield* Effect.tryPromise({
        try: () => runPiPrompt({ cwd: input.cwd, prompt, agentDir, model }),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: `Pi text generation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const generated = yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
        extractJsonObject(rawOutput),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Pi returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );

      return {
        title: sanitizeThreadTitle(generated.title),
      };
    },
  );

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
