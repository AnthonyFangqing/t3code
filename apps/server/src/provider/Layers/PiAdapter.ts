/**
 * PiAdapter — in-process Pi coding agent adapter.
 *
 * Uses `@mariozechner/pi-coding-agent`'s `createAgentSession` SDK directly
 * (no child process), matching how the Claude adapter uses
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * Features:
 * - File-persisted sessions in t3code state directory, keyed by ThreadId
 * - Runtime mode gating via beforeToolCall hook
 * - Rollback via Pi's tree-based session navigation
 * - Token usage, error, and compaction events
 * - Model selection with thinking level support
 *
 * @module PiAdapter
 */
import {
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Queue, Random, Ref, Scope, Stream } from "effect";

import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  SettingsManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import { type PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

interface PiSessionContext {
  session: ProviderSession;
  agentSession: AgentSession;
  sessionScope: Scope.Closeable;
  unsubscribeEvents: () => void;
  turnNumber: number;
  activeTurnId: TurnId | undefined;
  stopped: Ref.Ref<boolean>;
  sessionManager: SessionManager;
  /** Tracks last emitted text per assistant message to compute true deltas */
  emittedText: string;
  /** Tool args from most recent tool_execution_start, keyed by toolCallId */
  toolArgs: Map<string, unknown>;
}

function nowIso() { return new Date().toISOString(); }
function newEventId(): ProviderRuntimeEvent["eventId"] {
  return Random.nextUUIDv4.pipe(Effect.runSync) as ProviderRuntimeEvent["eventId"];
}

function requireSession(sessions: Map<ThreadId, PiSessionContext>, threadId: ThreadId): PiSessionContext {
  const ctx = sessions.get(threadId);
  if (!ctx) throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  if (Ref.getUnsafe(ctx.stopped)) throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  return ctx;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text).map((c) => c.text!).join("");
  }
  return "";
}

function toolDisplay(toolName: string, args: unknown): { title: string; detail: string | undefined } {
  const a = (args && typeof args === "object") ? args as Record<string, unknown> : undefined;
  switch (toolName) {
    case "bash":
      return { title: "Ran command", detail: typeof a?.command === "string" ? a.command : undefined };
    case "read":
      return { title: "Reading file", detail: typeof a?.path === "string" ? a.path : undefined };
    case "edit":
      return { title: "Editing file", detail: typeof a?.path === "string" ? a.path : undefined };
    case "write":
      return { title: "Writing file", detail: typeof a?.path === "string" ? a.path : undefined };
    case "find":
      return { title: "Finding files", detail: typeof a?.path === "string" ? a.path : undefined };
    case "grep":
      return { title: "Searching", detail: typeof a?.pattern === "string" ? a.pattern : undefined };
    case "ls":
      return { title: "Listing directory", detail: typeof a?.path === "string" ? a.path : undefined };
    default:
      return { title: toolName, detail: undefined };
  }
}

function toolItemType(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n === "bash") return "command_execution";
  if (n === "edit" || n === "write") return "file_change";
  return "dynamic_tool_call";
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly homePath: string | undefined;
  readonly defaultProvider: string | undefined;
  readonly defaultModel: string | undefined;
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const serverConfig = yield* ServerConfig;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const piHome = options?.homePath ?? piSettings.homePath ?? undefined;
    const agentDir = piHome ?? getAgentDir();

    const emit = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (c) => Effect.ignoreCause(stopContext(c)), { concurrency: "unbounded", discard: true });
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const stopContext = Effect.fn("stopContext")(function* (ctx: PiSessionContext) {
      if (yield* Ref.getAndSet(ctx.stopped, true)) return false;
      sessions.delete(ctx.session.threadId);
      ctx.unsubscribeEvents();
      ctx.agentSession.dispose();
      yield* Scope.close(ctx.sessionScope, Exit.void);
      return true;
    });

    function mkEvent(
      threadId: ThreadId, type: ProviderRuntimeEvent["type"], payload: Record<string, unknown>,
      turnId?: TurnId, itemId?: string, requestId?: string,
    ): ProviderRuntimeEvent {
      return {
        eventId: newEventId(), provider: PROVIDER, threadId, createdAt: nowIso(), type, payload,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(itemId !== undefined ? { itemId: itemId as ProviderRuntimeEvent["itemId"] } : {}),
        ...(requestId !== undefined ? { requestId: requestId as ProviderRuntimeEvent["requestId"] } : {}),
      } as ProviderRuntimeEvent;
    }

    // ── Model resolution ──────────────────────────────────────

    function parseModelSlug(slug: string) {
      const i = slug.indexOf("/");
      if (i <= 0 || i === slug.length - 1) return undefined;
      return { provider: slug.slice(0, i), modelId: slug.slice(i + 1) };
    }

    async function resolvePiModel(reg: ModelRegistry, slug: string): Promise<Model<any> | undefined> {
      const p = parseModelSlug(slug);
      if (!p) return undefined;
      return (await reg.getAvailable()).find((m) => m.provider === p.provider && m.id === p.modelId);
    }

    // ── Runtime mode → approval hook ──────────────────────────

    function installApprovalHook(ctx: PiSessionContext, runtimeMode: string) {
      const agent = ctx.agentSession.agent;
      // Capture runtime mode in closure instead of mutating context
      const mode = runtimeMode;

      if (mode === "full-access") return; // No gating needed

      agent.beforeToolCall = async (toolCtx) => {
        const tc = toolCtx.toolCall as unknown as Record<string, unknown>;
        const toolName = tc.function
          ? (tc.function as Record<string, string>).name ?? ""
          : "";

        if (mode === "approval-required") {
          if (toolName === "bash" || toolName === "edit" || toolName === "write") {
            return { block: true, reason: `Tool '${toolName}' requires approval in this runtime mode.` };
          }
        } else if (mode === "auto-accept-edits") {
          if (toolName === "bash") {
            return { block: true, reason: "Bash execution requires approval in this runtime mode." };
          }
        }
      };
    }

    function compactionFromRuntimeMode(mode: string): boolean {
      return mode !== "approval-required";
    }

    // ── Event pump ────────────────────────────────────────────

    const startEventPump = Effect.fn("startEventPump")(function* (ctx: PiSessionContext, threadId: ThreadId) {
      ctx.unsubscribeEvents = ctx.agentSession.subscribe((raw: AgentSessionEvent) => {
        Effect.runPromise(translateAndEmit(raw, ctx, threadId)).catch(() => {});
      });
    });

    const translateAndEmit = Effect.fn("translateAndEmit")(function* (
      event: AgentSessionEvent, ctx: PiSessionContext, threadId: ThreadId,
    ) {
      const tid = ctx.activeTurnId;
      switch (event.type) {
        case "agent_start": {
          ctx.activeTurnId = TurnId.make(`pi-turn-${ctx.turnNumber}`);
          ctx.emittedText = "";
          yield* emit(mkEvent(threadId, "turn.started", {
            model: ctx.agentSession.model ? `${ctx.agentSession.model.provider}/${ctx.agentSession.model.id}` : undefined,
          }, ctx.activeTurnId));
          break;
        }
        case "agent_end": {
          const finished = ctx.activeTurnId;
          ctx.activeTurnId = undefined;
          ctx.turnNumber += 1;
          // Token usage from last assistant message
          const msgs = ctx.agentSession.messages;
          const last = [...msgs].reverse().find((m) => m.role === "assistant");
          if (last && "usage" in last && last.usage) {
            const u = last.usage as unknown as Record<string, number>;
            const used = u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0));
            if (used > 0) {
              yield* emit(mkEvent(threadId, "thread.token-usage.updated", { usage: {
                usedTokens: used, lastUsedTokens: used,
                ...(u.input ? { inputTokens: u.input, lastInputTokens: u.input } : {}),
                ...(u.output ? { outputTokens: u.output, lastOutputTokens: u.output } : {}),
                compactsAutomatically: ctx.agentSession.autoCompactionEnabled,
              }}, finished));
            }
          }
          if (finished) yield* emit(mkEvent(threadId, "turn.completed", { state: "completed" }, finished));
          break;
        }
        case "message_start": {
          if (event.message.role === "assistant")
            yield* emit(mkEvent(threadId, "item.started", { itemType: "assistant_message", status: "inProgress", title: "Assistant message" }, tid, `asst-${Date.now()}`));
          break;
        }
        case "message_update": {
          if (event.message.role !== "assistant") break;
          const full = extractText(event.message.content);
          if (!full) break;
          const prev = ctx.emittedText;
          if (full.startsWith(prev)) {
            const delta = full.slice(prev.length);
            ctx.emittedText = full;
            if (delta) {
              yield* emit(mkEvent(threadId, "content.delta", {
                streamKind: "assistant_text" as const, delta,
              }, tid));
            }
          } else {
            // Text was replaced (e.g. compaction or retry) — emit full new text
            ctx.emittedText = full;
            yield* emit(mkEvent(threadId, "content.delta", {
              streamKind: "assistant_text" as const, delta: full,
            }, tid));
          }
          break;
        }
        case "message_end": {
          if (event.message.role !== "assistant") break;
          yield* emit(mkEvent(threadId, "item.completed", { itemType: "assistant_message", status: "completed", title: "Assistant message" }, tid));
          break;
        }
        case "tool_execution_start": {
          ctx.toolArgs.set(event.toolCallId, event.args);
          const display = toolDisplay(event.toolName, event.args);
          yield* emit(mkEvent(threadId, "item.started", {
            itemType: toolItemType(event.toolName), status: "inProgress",
            title: display.title,
            ...(display.detail ? { detail: display.detail } : {}),
          }, tid, event.toolCallId));
          break;
        }
        case "tool_execution_end": {
          const storedArgs = ctx.toolArgs.get(event.toolCallId);
          ctx.toolArgs.delete(event.toolCallId);
          const displayEnd = toolDisplay(event.toolName, storedArgs);
          yield* emit(mkEvent(threadId, "item.completed", {
            itemType: toolItemType(event.toolName),
            status: event.isError ? "failed" as const : "completed" as const,
            title: displayEnd.title,
            ...(displayEnd.detail ? { detail: displayEnd.detail } : {}),
          }, tid, event.toolCallId));
          break;
        }
        case "tool_execution_update": {
          const s = typeof event.partialResult === "string" ? event.partialResult : "";
          if (s) yield* emit(mkEvent(threadId, "tool.progress", { summary: s }, tid, event.toolCallId));
          break;
        }
        case "compaction_start":
          yield* emit(mkEvent(threadId, "runtime.warning", { message: `Context compaction started (reason: ${event.reason})` }));
          break;
        case "compaction_end": {
          if (event.errorMessage)
            yield* emit(mkEvent(threadId, "runtime.error", { message: `Compaction failed: ${event.errorMessage}`, class: "provider_error" }));
          else if (!event.aborted && event.result) {
            const cr = event.result as unknown as Record<string, unknown>;
            yield* emit(mkEvent(threadId, "runtime.warning", { message: `Context compacted: ${cr.tokensBefore ?? "?"} → ${cr.tokensAfter ?? "?"} tokens` }));
          }
          break;
        }
        case "auto_retry_start":
          yield* emit(mkEvent(threadId, "runtime.warning", { message: `Auto-retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` }));
          break;
        case "thinking_level_changed":
          yield* emit(mkEvent(threadId, "thread.metadata.updated", { metadata: { thinkingLevel: event.level } }));
          break;
        default: break;
      }
    });

    // ── Thread snapshot (readThread) ──────────────────────────

    function buildThreadSnapshot(sm: SessionManager, threadId: ThreadId) {
      const entries = sm.getEntries();
      const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
      let cur: { id: TurnId; items: Array<unknown> } | undefined;
      let count = 0;
      for (const e of entries) {
        const entry = e as unknown as Record<string, unknown>;
        if (entry.type === "message" && entry.message && typeof entry.message === "object") {
          const msg = entry.message as Record<string, unknown>;
          if (msg.role === "user") {
            if (cur) turns.push(cur);
            cur = { id: TurnId.make(`pi-turn-${count++}`), items: [msg] };
          } else if (cur) {
            cur.items.push(msg);
          }
        }
      }
      if (cur) turns.push(cur);
      return { threadId, turns };
    }

    // ── Adapter methods ───────────────────────────────────────

    const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
      const existing = sessions.get(input.threadId);
      if (existing) yield* stopContext(existing);

      const cwd = input.cwd ?? serverConfig.cwd;
      const sessionScope = yield* Scope.make();

      const authStorage = AuthStorage.create(piHome ? `${piHome}/auth.json` : undefined);
      const modelRegistry = ModelRegistry.create(authStorage, piHome ? `${piHome}/models.json` : undefined);
      const settingsManager = SettingsManager.create(cwd, agentDir);

      // File-backed session in t3code state dir
      const sessionsDir = `${serverConfig.stateDir}/pi-sessions`;
      const sessionPath = `${sessionsDir}/${input.threadId}.jsonl`;
      const sessionManager: SessionManager = SessionManager.open(sessionPath, sessionsDir, cwd);

      let thinkingLevel: string | undefined;
      if (input.modelSelection?.instanceId === boundInstanceId && input.modelSelection.model) {
        thinkingLevel = getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel");
      }

      const { session: agentSession } = yield* Effect.tryPromise({
        try: () => createAgentSession({
          cwd, agentDir, authStorage, modelRegistry, settingsManager, sessionManager,
          ...(thinkingLevel ? { thinkingLevel: thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
          tools: ["read", "bash", "edit", "write"],
          sessionStartEvent: { type: "session_start", reason: "new" },
        }),
        catch: (cause) => new ProviderAdapterProcessError({
          provider: PROVIDER, threadId: input.threadId,
          detail: `Failed to create Pi agent session: ${cause instanceof Error ? cause.message : String(cause)}`, cause,
        }),
      });

      // Resolve model selection AFTER extensions have loaded (extensions may add providers)
      let selectedModel: Model<any> | undefined;
      if (input.modelSelection?.instanceId === boundInstanceId && input.modelSelection.model) {
        selectedModel = yield* Effect.promise(() => resolvePiModel(modelRegistry, input.modelSelection!.model).catch(() => undefined));
        if (selectedModel) {
          yield* Effect.promise(() => agentSession.setModel(selectedModel!).catch(() => {}));
        }
      }

      agentSession.setAutoCompactionEnabled(compactionFromRuntimeMode(input.runtimeMode));

      const stopped = yield* Ref.make(false);
      const ctx: PiSessionContext = {
        session: {
          provider: PROVIDER, providerInstanceId: boundInstanceId,
          status: "ready", runtimeMode: input.runtimeMode, cwd,
          threadId: input.threadId, createdAt: nowIso(), updatedAt: nowIso(),
          ...(selectedModel ? { model: `${selectedModel.provider}/${selectedModel.id}` } : {}),
        },
        agentSession, sessionScope, unsubscribeEvents: () => {},
        turnNumber: 0, activeTurnId: undefined, stopped, sessionManager,
        emittedText: "",
        toolArgs: new Map(),
      };

      // Install approval hook based on runtime mode
      installApprovalHook(ctx, input.runtimeMode);

      sessions.set(input.threadId, ctx);
      yield* startEventPump(ctx, input.threadId);
      yield* emit(mkEvent(input.threadId, "session.started", {}));
      yield* emit(mkEvent(input.threadId, "thread.started", { providerThreadId: input.threadId }));
      return ctx.session;
    });

    const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const ctx = requireSession(sessions, input.threadId);

      if (input.modelSelection?.instanceId === boundInstanceId && input.modelSelection.model) {
        const cur = ctx.agentSession.model;
        const curSlug = cur ? `${cur.provider}/${cur.id}` : undefined;
        if (input.modelSelection.model !== curSlug) {
          const nm = yield* Effect.promise(() => resolvePiModel(ctx.agentSession.modelRegistry, input.modelSelection!.model).catch(() => undefined));
          if (nm) {
            yield* Effect.promise(() => ctx.agentSession.setModel(nm).catch(() => {}));
            ctx.session = { ...ctx.session, model: `${nm.provider}/${nm.id}`, updatedAt: nowIso() };
          }
        }
        const tl = getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel");
        if (tl) ctx.agentSession.setThinkingLevel(tl as "off" | "minimal" | "low" | "medium" | "high" | "xhigh");
      }

      ctx.activeTurnId = TurnId.make(`pi-turn-${ctx.turnNumber}`);
      yield* Effect.tryPromise({
        try: () => ctx.agentSession.prompt(input.input ?? ""),
        catch: (cause) => new ProviderAdapterProcessError({
          provider: PROVIDER, threadId: input.threadId,
          detail: `Failed to send Pi turn: ${cause instanceof Error ? cause.message : String(cause)}`, cause,
        }),
      });
      return { threadId: input.threadId, turnId: ctx.activeTurnId } satisfies ProviderTurnStartResult;
    });

    const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(function* (threadId, _turnId) {
      const ctx = requireSession(sessions, threadId);
      yield* Effect.tryPromise({
        try: () => ctx.agentSession.abort(),
        catch: (cause) => new ProviderAdapterProcessError({
          provider: PROVIDER, threadId, detail: `Failed to abort Pi turn: ${cause instanceof Error ? cause.message : String(cause)}`, cause,
        }),
      });
      yield* emit(mkEvent(threadId, "turn.aborted", { reason: "Interrupted by user." }, ctx.activeTurnId));
    });

    const respondToRequest: PiAdapterShape["respondToRequest"] = () => Effect.void;
    const respondToUserInput: PiAdapterShape["respondToUserInput"] = () => Effect.void;

    const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      const did = yield* stopContext(ctx);
      if (!did) return;
      yield* emit(mkEvent(threadId, "session.exited", { reason: "Session stopped." }));
    });

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((c) => c.session));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !Ref.getUnsafe(sessions.get(threadId)!.stopped));

    const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
      const ctx = requireSession(sessions, threadId);
      return buildThreadSnapshot(ctx.sessionManager, threadId);
    });

    const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(function* (threadId, numTurns) {
      const ctx = requireSession(sessions, threadId);
      const entries = ctx.sessionManager.getEntries();
      const userIndices: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i] as unknown as Record<string, unknown>;
        if (e.type === "message" && e.message && typeof e.message === "object") {
          const msg = e.message as Record<string, unknown>;
          if (msg.role === "user") userIndices.push(i);
        }
      }
      if (userIndices.length <= numTurns || numTurns < 1) {
        return { threadId, turns: [] };
      }
      const targetIndex = userIndices[userIndices.length - numTurns - 1]!;
      const targetEntry = entries[targetIndex];
      if (targetEntry) {
        ctx.sessionManager.createBranchedSession(targetEntry.id);
      }
      return buildThreadSnapshot(ctx.sessionManager, threadId);
    });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (c) => Effect.ignoreCause(stopContext(c)), { concurrency: "unbounded", discard: true });
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" as const },
      startSession, sendTurn, interruptTurn,
      respondToRequest, respondToUserInput,
      stopSession, listSessions, hasSession,
      readThread, rollbackThread, stopAll,
      get streamEvents() { return Stream.fromQueue(runtimeEvents); },
    } satisfies PiAdapterShape;
  });
}
