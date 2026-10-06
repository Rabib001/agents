/**
 * The Claude Code adapter: one long-lived Agent SDK `query()` per harness
 * session, in streaming-input mode, fed one user message per turn.
 *
 * Resume across containers rides the SDK's `SessionStore`. Every batch of
 * transcript entries Claude Code writes is mirrored to the Durable Object
 * through `persist()`. When the session opens in a new container, the
 * object hands every mirrored batch back as `restore`; the store answers
 * the SDK's `load()` from them, and the query resumes the same Claude Code
 * session with full fidelity (signed thinking included, because Claude
 * Code replays its own entries rather than a reconstruction).
 *
 * A fork resumes the parent's Claude Code session with `forkSession`, so
 * the branch gets a session id of its own and never writes into the
 * parent's transcript.
 */

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterContext,
  AdapterSession,
  AdapterTurn,
  ContainerAdapter,
  ContainerInput,
  ContainerOutcome,
  JsonValue
} from "agents/harness/container/daemon";
import { MirrorStore } from "./claude-mirror";
import { ClaudeProjection, type SdkMessageLike } from "./claude-projection";

/** Claude Code settings, from the harness's `defaults.options`. */
export type ClaudeCodeOptions = {
  /**
   * Working directory. Pinned for a session's life: the SDK derives the
   * transcript's project key from it. Default `/workspace`.
   */
  readonly cwd?: string;
  /**
   * Default `bypassPermissions`: the container is the sandbox. Claude Code
   * refuses that mode as root, so run the image as an unprivileged user.
   */
  readonly permissionMode?: Options["permissionMode"];
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Appended to Claude Code's own system prompt. */
  readonly appendSystemPrompt?: string;
  readonly maxTurns?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptions(value: JsonValue | undefined): ClaudeCodeOptions {
  if (!isRecord(value)) return {};
  const strings = (field: unknown) =>
    Array.isArray(field) && field.every((each) => typeof each === "string")
      ? field
      : undefined;
  const allowed = strings(value.allowedTools);
  const disallowed = strings(value.disallowedTools);
  return {
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.permissionMode === "string"
      ? {
          // SAFETY: the SDK validates the mode and fails the query on an
          // unknown one; the adapter passes the configured name through.
          permissionMode: value.permissionMode as Options["permissionMode"]
        }
      : {}),
    ...(allowed ? { allowedTools: allowed } : {}),
    ...(disallowed ? { disallowedTools: disallowed } : {}),
    ...(typeof value.appendSystemPrompt === "string"
      ? { appendSystemPrompt: value.appendSystemPrompt }
      : {}),
    ...(typeof value.maxTurns === "number" ? { maxTurns: value.maxTurns } : {})
  };
}

/** The prompt iterable the SDK consumes: one message per turn. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiting: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  #closed = false;

  push(item: SDKUserMessage): void {
    if (this.#closed) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiting.push(resolve));
      }
    };
  }
}

function userMessage(input: ContainerInput): SDKUserMessage {
  const content =
    typeof input === "string"
      ? input
      : input.map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  // SAFETY: the harness passes the media type the client
                  // gave; the API rejects a type it does not accept.
                  media_type: part.mediaType as "image/png",
                  data: part.data
                }
              }
        );
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null
  };
}

type Active = {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly resolve: (outcome: ContainerOutcome) => void;
  readonly reject: (error: unknown) => void;
};

class ClaudeCodeSession implements AdapterSession {
  readonly #queue = new MessageQueue();
  readonly #projection = new ClaudeProjection();
  readonly #query: Query;
  readonly #context: AdapterContext;
  #active: Active | undefined;
  #exited: unknown;

  constructor(
    context: AdapterContext,
    defaults: ClaudeCodeOptions,
    query: typeof sdkQuery
  ) {
    this.#context = context;
    const options = { ...defaults, ...parseOptions(context.settings.options) };
    const store = new MirrorStore(context.restore, (batch) => {
      // SAFETY: the SDK documents transcript entries as JSON-safe objects.
      context.persist([batch as unknown as JsonValue]);
    });
    const resume = store.lastSession;
    this.#query = query({
      prompt: this.#queue,
      options: {
        cwd: options.cwd ?? "/workspace",
        permissionMode: options.permissionMode ?? "bypassPermissions",
        ...(options.permissionMode === undefined ||
        options.permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        includePartialMessages: true,
        sessionStore: store,
        ...(context.settings.model === undefined
          ? {}
          : { model: context.settings.model }),
        ...(resume === undefined ? {} : { resume }),
        ...(resume !== undefined && context.fork ? { forkSession: true } : {}),
        ...(options.allowedTools === undefined
          ? {}
          : { allowedTools: [...options.allowedTools] }),
        ...(options.disallowedTools === undefined
          ? {}
          : { disallowedTools: [...options.disallowedTools] }),
        ...(options.maxTurns === undefined
          ? {}
          : { maxTurns: options.maxTurns }),
        ...(options.appendSystemPrompt === undefined
          ? {}
          : {
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: options.appendSystemPrompt
              }
            }),
        // `Options.env` replaces the environment; keep the container's.
        env: { ...process.env, DISABLE_AUTOUPDATER: "1" }
      }
    });
    void this.#consume();
  }

  async run(turn: AdapterTurn): Promise<ContainerOutcome> {
    if (this.#exited !== undefined) {
      throw new Error(`Claude Code exited: ${String(this.#exited)}`);
    }
    return new Promise<ContainerOutcome>((resolve, reject) => {
      const onAbort = () => {
        void this.#query.interrupt().catch(() => undefined);
      };
      turn.signal.addEventListener("abort", onAbort, { once: true });
      this.#active = {
        operationId: turn.operationId,
        signal: turn.signal,
        resolve: (outcome) => {
          turn.signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
        reject: (error) => {
          turn.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      };
      this.#queue.push(userMessage(turn.input));
    });
  }

  async configure(settings: { readonly model?: string }): Promise<void> {
    await this.#query.setModel(settings.model);
  }

  async close(): Promise<void> {
    this.#queue.close();
    await this.#query.interrupt().catch(() => undefined);
    this.#query.close();
  }

  async #consume(): Promise<void> {
    try {
      for await (const message of this.#query) this.#handle(message);
      this.#exit("the query ended");
    } catch (error) {
      this.#exit(error instanceof Error ? error.message : String(error));
    }
  }

  #handle(message: SDKMessage): void {
    // SAFETY: `SdkMessageLike` is a structural subset of `SDKMessage`; the
    // projection reads only fields it checks.
    const like = message as unknown as SdkMessageLike;
    const active = this.#active;
    for (const event of this.#projection.project(like, active?.operationId)) {
      this.#context.emit(event);
    }
    if (message.type === "result" && active) {
      this.#active = undefined;
      active.resolve(this.#projection.outcome(like, active.signal.aborted));
    }
  }

  #exit(reason: string): void {
    this.#exited = reason;
    const active = this.#active;
    this.#active = undefined;
    active?.reject(new Error(`Claude Code exited: ${reason}`));
  }
}

/**
 * The Claude Code adapter.
 *
 * @param defaults - Settings for every session; a session's
 *   `defaults.options` from the harness override them.
 * @returns The adapter.
 */
export function claudeCode(defaults: ClaudeCodeOptions = {}): ContainerAdapter {
  return {
    id: "claude-code",
    version: "1",
    capabilities: ["resume", "fork", "model"],
    async open(context) {
      // Loaded on first use, so an image without the SDK can still run
      // another adapter from the same bundle.
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      return new ClaudeCodeSession(context, defaults, query);
    }
  };
}
