import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../../lifecycle";
import {
  openHarnessStore,
  type HarnessStore,
  type JsonValue,
  type OperationRecord
} from "../store/store";
import { DaemonLink, waitHealthy, type Hello, type LinkError } from "./link";
import {
  chunkEntries,
  CONTAINER_ENV,
  type ContainerInput,
  type ContainerMessage,
  type ContainerOutcome,
  type ContainerPart,
  type ContainerSettings,
  type ContainerWhenBusy,
  type DaemonFrame
} from "./protocol";
import type {
  ContainerEventStream,
  ContainerOperationResult,
  ContainerPendingOperation,
  ContainerPromptResponse,
  ContainerReceipt,
  ContainerSessionEvent,
  ContainerSessionId,
  ContainerSessionInfo,
  ContainerSessionOptions,
  ContainerSessionSnapshot,
  ContainerSubmitOptions
} from "./types";

/** The root session's id. */
export const ROOT_SESSION: ContainerSessionId = "root";

/** Default `idleTimeoutMs`: the container stops five minutes after its last work. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Default `startTimeoutMs`: how long a new container may take to answer. */
const START_TIMEOUT_MS = 60_000;

/** How long a container that already runs may take to answer before it is replaced. */
const ADOPT_TIMEOUT_MS = 10_000;

/** Default `port`: where the daemon listens in the container. */
const DAEMON_PORT = 8080;

/**
 * Longest one wake waits on the container. It waits inside an alarm
 * invocation, which has a 15 minute wall-time limit, so a longer run is
 * waited on across several alarms.
 */
const WAIT_BUDGET_MS = 10 * 60_000;

/**
 * The wake job's heartbeat while it waits. If the object is evicted, the
 * job is still due and its alarm restarts the object, which reattaches.
 */
const HEARTBEAT_MS = 30_000;

/** Consecutive failed starts before a session's open work is given up. */
const MAX_START_FAILURES = 5;

/** How often a wait checks that the container still runs. */
const CONTAINER_CHECK_MS = 2_000;

/** Frames between acknowledgements, so the daemon can forget them. */
const ACK_EVERY = 32;

const WAKE_FN = "wake";
const IDLE_FN = "idle";
const IDLE_JOB = "container-idle";
const RUNTIME_KEY = "container-harness:runtime";
const MESSAGES = "messages";
const ENGINE = "engine";
const OPEN: readonly ("queued" | "running")[] = ["queued", "running"];

/** How long the wake waits, for tests. */
type WakeTiming = {
  readonly waitBudgetMs?: number;
  readonly heartbeatMs?: number;
  /** First retry delay after a failed start; doubles per failure. */
  readonly retryBaseMs?: number;
  /** Delay of the idle stop. Default: `idleTimeoutMs`. */
  readonly idleStopMs?: number;
};

let setWakeTiming: (harness: ContainerHarness, timing: WakeTiming) => void;

/**
 * @internal Shorten a harness's wake timings, so a test suite does not sit
 * on the real heartbeat. Not exported from `agents/harness/container`.
 */
export function setWakeTimingForTests(
  harness: ContainerHarness,
  timing: WakeTiming
): void {
  setWakeTiming(harness, timing);
}

function wakeJobId(session: ContainerSessionId): string {
  return `container-wake:${session}`;
}

function sessionOfJob(payload: unknown): ContainerSessionId | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    "session" in payload &&
    typeof payload.session === "string"
    ? payload.session
    : undefined;
}

/**
 * How the container is launched. With the `durable_object` scheduling
 * policy, `image` is a value from `ctx.container.images`.
 */
export type ContainerLaunch = {
  /** The image, such as `ctx.container.images.agent`. */
  readonly image?: string;
  /** Instance size, such as `"standard-2"`. Default: the platform's. */
  readonly instance?:
    | string
    | {
        readonly vcpu: number;
        readonly memoryMib: number;
        readonly diskMb: number;
      };
  /** Command and arguments. Default: the image's entrypoint. */
  readonly entrypoint?: readonly string[];
  /** Environment for the daemon and the agent it runs. */
  readonly env?: { readonly [name: string]: string };
  /** Whether the container may reach the Internet. */
  readonly enableInternet: boolean;
};

/** Applied to a session the first time it is created. */
export type ContainerSessionDefaults = {
  /** The adapter's model name. Change one session's with `session.setModel`. */
  readonly model?: string;
  /** Adapter options, passed through to the adapter untouched. */
  readonly options?: JsonValue;
};

/** `ContainerHarness`'s options. */
export type ContainerHarnessOptions = {
  /** The object's container: `ctx.container`. */
  readonly container: Container;
  /** How to start it. */
  readonly launch: ContainerLaunch;
  /** Where the daemon listens. Default 8080. */
  readonly port?: number;
  /**
   * How long the container keeps running after its last work, in
   * milliseconds. The next prompt starts a new one and resumes the session
   * in it. Default five minutes; at most six hours.
   */
  readonly idleTimeoutMs?: number;
  /** How long a new container may take to answer. Default 60 seconds. */
  readonly startTimeoutMs?: number;
  /** What a new session starts with. */
  readonly defaults?: ContainerSessionDefaults;
  /**
   * What happens to an operation whose container stopped while it ran.
   *
   * - `fail` (default): it settles `unanswered` with `container_lost`. The
   *   session itself survives: the next prompt resumes it in a new
   *   container, from everything the adapter persisted.
   * - `retry`: it runs again from the start in the new container. Only safe
   *   when the agent's tools can be repeated.
   */
  readonly onContainerLost?: "fail" | "retry";
  /** Table prefix for the session store. Default `container_`. */
  readonly storePrefix?: string;
};

/** What the harness keeps per session, in the store's session state. */
type SessionState = {
  readonly model: string | undefined;
  /** The newest frame stored, by container. */
  readonly cursor: { readonly runtimeId: string; readonly seq: number } | null;
  /** Bumped on reset: a new adapter session, without the old history. */
  readonly generation: number;
  /** Messages before this log position belong to an earlier context. */
  readonly messagesFrom: number;
  /** A note prepended to the first prompt after a reset. */
  readonly handoff: string | undefined;
  /** The engine log is the parent's until the adapter persists its own. */
  readonly fork: boolean;
};

/** What the harness keeps per operation, in the store's operation meta. */
type OperationMeta = {
  readonly whenBusy: ContainerWhenBusy;
  /** The container the operation was handed to, if any. */
  readonly delivered: string | null;
};

type Runtime = { readonly runtimeId: string; readonly token: string };

type Attached = {
  readonly link: DaemonLink;
  readonly runtimeId: string;
  sinceAck: number;
  /** Settled in the container per `hello`; applied once the replay is done. */
  readonly settledThere: {
    readonly operationId: string;
    readonly outcome: ContainerOutcome;
  }[];
};

function isRecord(
  value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionState(value: JsonValue): SessionState {
  const fields = isRecord(value) ? value : {};
  const cursor = fields.cursor;
  return {
    model: typeof fields.model === "string" ? fields.model : undefined,
    cursor:
      isRecord(cursor) &&
      typeof cursor.runtimeId === "string" &&
      typeof cursor.seq === "number"
        ? { runtimeId: cursor.runtimeId, seq: cursor.seq }
        : null,
    generation: typeof fields.generation === "number" ? fields.generation : 1,
    messagesFrom:
      typeof fields.messagesFrom === "number" ? fields.messagesFrom : 0,
    handoff: typeof fields.handoff === "string" ? fields.handoff : undefined,
    fork: fields.fork === true
  };
}

function sessionStateJson(state: SessionState): JsonValue {
  return {
    ...(state.model === undefined ? {} : { model: state.model }),
    cursor: state.cursor,
    generation: state.generation,
    messagesFrom: state.messagesFrom,
    ...(state.handoff === undefined ? {} : { handoff: state.handoff }),
    fork: state.fork
  };
}

function parseMeta(value: JsonValue): OperationMeta {
  const fields = isRecord(value) ? value : {};
  return {
    whenBusy: fields.whenBusy === "steer" ? "steer" : "followUp",
    delivered: typeof fields.delivered === "string" ? fields.delivered : null
  };
}

function metaJson(meta: OperationMeta): JsonValue {
  return { whenBusy: meta.whenBusy, delivered: meta.delivered };
}

function parseInput(value: JsonValue): ContainerInput {
  if (typeof value === "string") return value;
  // SAFETY: inputs are stored only by `enqueue`, from a `ContainerInput`.
  return value as unknown as ContainerInput;
}

function inputJson(input: ContainerInput): JsonValue {
  // SAFETY: a `ContainerInput` is plain JSON (strings and part objects).
  return input as unknown as JsonValue;
}

function parseMessage(value: JsonValue): ContainerMessage {
  // SAFETY: the messages log is written only by `#onFrame`, from parsed
  // `ContainerMessage`s.
  return value as unknown as ContainerMessage;
}

function messageJson(message: ContainerMessage): JsonValue {
  // SAFETY: a `ContainerMessage` is plain JSON.
  return message as unknown as JsonValue;
}

function userParts(input: ContainerInput): ContainerPart[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return input.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", mediaType: part.mediaType, data: part.data }
  );
}

function withHandoff(input: ContainerInput, handoff: string): ContainerInput {
  const note = { type: "text", text: handoff } as const;
  if (typeof input === "string") return [note, { type: "text", text: input }];
  return [note, ...input];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An agent CLI running in a Cloudflare Container, driven from a Durable
 * Object, behind the same interface as `PiHarness`: `harness.prompt()`,
 * `harness.sessions`, `harness.session(id)`.
 *
 * The harness does not know which agent runs in the container. The image
 * runs the harness daemon (`@cloudflare/harness-daemon`) with an adapter,
 * such as Claude Code, and the two speak the wire in `./protocol`. Any
 * adapter that produces `ContainerEvent`s works.
 *
 * The object owns the durable record, in a `HarnessStore`: sessions,
 * operations, the transcript, and the adapter's resume state. The container
 * is disposable. It is started on demand with `ctx.container.start()`, kept
 * for `idleTimeoutMs` after its last work, and then stopped. The next
 * prompt starts a new container and hands the adapter everything it
 * persisted, so the agent resumes its own session there.
 *
 * Each session has one Lifecycle wake job. It runs while the session has
 * open operations: it starts or reattaches to the container, reconciles
 * what the container knows with what the object stored, delivers queued
 * operations, and waits for them, rescheduling itself as a heartbeat. An
 * eviction mid-run leaves the job due, so its alarm restarts the object,
 * which reattaches and replays the frames it missed from its cursor.
 *
 * Recovery, by what was lost:
 *
 * - **The object** (eviction, deploy): the container keeps running for
 *   `idleTimeoutMs`. The wake reattaches and replays from the cursor.
 * - **The socket**: the same, on the next heartbeat.
 * - **The container** (idle stop, crash, platform restart): a new one
 *   answers with a different runtime id. The session is reopened in it
 *   from the persisted resume state; queued operations run there; an
 *   operation that was running is settled `container_lost` or run again,
 *   per `onContainerLost`.
 *
 * @beta The API may change between releases.
 */
export class ContainerHarness extends LifecycleCapability {
  /** Every session in this object. */
  readonly sessions: ContainerSessions;
  readonly #options: ContainerHarnessOptions;
  readonly #idleTimeoutMs: number;
  readonly #startTimeoutMs: number;
  #waitBudgetMs = WAIT_BUDGET_MS;
  #heartbeatMs = HEARTBEAT_MS;
  #retryBaseMs = 1_000;
  #idleStopMs: number;
  #store: HarnessStore | undefined;
  #runtime: Runtime | undefined;
  #starting: Promise<RuntimeResult> | undefined;
  #timeoutSet = false;
  readonly #attached = new Map<ContainerSessionId, Attached>();
  readonly #attaching = new Map<ContainerSessionId, Promise<AttachResult>>();
  /** In-memory waits on the container, per session, inside an alarm's work. */
  readonly #waits = new Map<ContainerSessionId, Promise<void>>();
  readonly #failures = new Map<ContainerSessionId, number>();
  /** Wakes `wait()` callers when an operation settles. */
  readonly #settleWaiters = new Map<string, Set<() => void>>();
  /** Wakes the wake job when a session's work or link changes. */
  readonly #changeWaiters = new Map<ContainerSessionId, Set<() => void>>();
  readonly #listeners = new Map<
    ContainerSessionId,
    Set<(events: readonly ContainerSessionEvent[]) => void>
  >();

  static {
    setWakeTiming = (harness, timing) => harness.#setWakeTiming(timing);
  }

  /**
   * @param options - The container, how to launch it, and session defaults.
   */
  constructor(options: ContainerHarnessOptions) {
    super("container-harness");
    const idle = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    if (!Number.isFinite(idle) || idle <= 0 || idle > 6 * 60 * 60_000) {
      throw new Error(
        "ContainerHarness idleTimeoutMs must be positive and at most six hours"
      );
    }
    this.#options = options;
    this.#idleTimeoutMs = idle;
    this.#startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.#idleStopMs = idle;
    this.sessions = new ContainerSessions(this);
  }

  #setWakeTiming(timing: WakeTiming): void {
    for (const [name, value] of Object.entries(timing)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `ContainerHarness timing.${name} must be a positive number`
        );
      }
    }
    this.#waitBudgetMs = timing.waitBudgetMs ?? this.#waitBudgetMs;
    this.#heartbeatMs = timing.heartbeatMs ?? this.#heartbeatMs;
    this.#retryBaseMs = timing.retryBaseMs ?? this.#retryBaseMs;
    this.#idleStopMs = timing.idleStopMs ?? this.#idleStopMs;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Reopen the store, re-arm the container's idle timeout, and wake open sessions. */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const store = await this.#openStore();
    const container = this.#options.container;
    if (container.running) {
      // A restarted object starts without the container's inactivity
      // timeout; without it, the container stops shortly after the object
      // goes quiet.
      await container.setInactivityTimeout(this.#idleTimeoutMs);
      this.#timeoutSet = true;
    }
    const open = store.operations({ status: OPEN });
    const sessions = new Set(open.map((operation) => operation.session));
    for (const session of sessions) await this.#wake(session);
    if (sessions.size === 0 && container.running) await this.#scheduleIdle();
  }

  /** Dispatch the harness's jobs: one wake per session, and the idle stop. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn === IDLE_FN) return this.#idleStep();
    if (context.job.fn !== WAKE_FN) return;
    const session = sessionOfJob(context.job.payload);
    if (session !== undefined) return this.#wakeStep(session);
  }

  /** Close the session sockets. Durable state and the container are untouched. */
  async dispose(): Promise<void> {
    for (const session of [...this.#attached.keys()]) this.#detach(session);
  }

  // ── The harness interface ────────────────────────────────────────────────

  /**
   * A handle on one session. No I/O until you call it.
   *
   * @param id - The session. Default: the root session.
   * @returns The handle.
   */
  session(id: ContainerSessionId = ROOT_SESSION): ContainerSession {
    return new ContainerSession(this, id);
  }

  /**
   * Submit a prompt and wait for its answer.
   *
   * @param input - The prompt.
   * @param options - Session, idempotency key, and busy behaviour.
   * @returns The result, with the session's transcript after it.
   */
  prompt(
    input: ContainerInput,
    options: ContainerSubmitOptions = {}
  ): Promise<ContainerPromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  /**
   * Durably submit a prompt. Resolves before the agent runs.
   *
   * @param input - The prompt.
   * @param options - Session, idempotency key, and busy behaviour.
   * @returns The receipt.
   */
  submit(
    input: ContainerInput,
    options: ContainerSubmitOptions = {}
  ): Promise<ContainerReceipt> {
    return this.session(options.session).submit(input, options);
  }

  /**
   * Stop one operation, or everything running in a session.
   *
   * @param options - The session, and optionally one operation.
   * @returns Whether anything was stopped.
   */
  abort(
    options: ContainerSessionOptions & { readonly operationId?: string } = {}
  ): Promise<boolean> {
    return this.session(options.session).abort(options.operationId);
  }

  /**
   * Wait for an operation to settle.
   *
   * @param operationId - The operation.
   * @param options - The session, and a signal that stops only the wait.
   * @returns How it ended.
   */
  wait(
    operationId: string,
    options: ContainerSessionOptions & { readonly signal?: AbortSignal } = {}
  ): Promise<ContainerOperationResult> {
    return this.session(options.session).wait(operationId, options.signal);
  }

  /**
   * The session's active transcript.
   *
   * @param options - The session.
   * @returns Its messages since the newest reset.
   */
  messages(options: ContainerSessionOptions = {}): Promise<ContainerMessage[]> {
    return this.session(options.session).messages();
  }

  /**
   * Submissions that have not settled yet, oldest first.
   *
   * @param options - Narrow to one session. Default: every session.
   * @returns The open operations.
   */
  async pending(
    options: ContainerSessionOptions = {}
  ): Promise<ContainerPendingOperation[]> {
    const store = await this.#openStore();
    return store
      .operations({
        ...(options.session === undefined ? {} : { session: options.session }),
        status: OPEN
      })
      .map((operation) => ({
        operationId: operation.id,
        session: operation.session,
        status: operation.status === "running" ? "running" : "queued"
      }));
  }

  /**
   * The container, as the harness sees it.
   *
   * @returns Whether it runs, and the id the harness started it with.
   */
  async container(): Promise<{
    readonly running: boolean;
    readonly runtimeId: string | undefined;
  }> {
    const runtime = await this.#runtimeRecord();
    return {
      running: this.#options.container.running,
      runtimeId: runtime?.runtimeId
    };
  }

  /**
   * Stop the container now. Sessions survive: the next prompt starts a new
   * container and resumes them in it. Running operations are reconciled as
   * if the container had died.
   */
  async stop(): Promise<void> {
    await this.dispose();
    if (this.#options.container.running) {
      await this.#options.container.destroy();
    }
    this.#broadcast({ type: "container", status: "stopped" });
    const store = await this.#openStore();
    const sessions = new Set(
      store.operations({ status: OPEN }).map((operation) => operation.session)
    );
    for (const session of sessions) await this.#wake(session);
  }

  // ── Used by ContainerSession and ContainerSessions ───────────────────────

  /** @internal */
  async store(): Promise<HarnessStore> {
    return this.#openStore();
  }

  /** @internal Create a session with the defaults, or fork one. */
  async createSession(
    id: ContainerSessionId,
    from?: ContainerSessionId
  ): Promise<void> {
    const store = await this.#openStore();
    store.transaction(() => {
      if (from === undefined) {
        store.createSession({ id, state: sessionStateJson(this.#initial()) });
        return;
      }
      const parent = store.session(from);
      if (!parent) throw new Error(`Unknown container session ${from}`);
      const parentState = parseSessionState(parent.state);
      store.createSession({
        id,
        parent: from,
        state: sessionStateJson({
          ...this.#initial(),
          model: parentState.model,
          fork: true
        })
      });
      // The fork sees the parent's active transcript and resumes the
      // parent's agent session as a branch.
      store.append(
        id,
        MESSAGES,
        store
          .read(from, MESSAGES, { after: parentState.messagesFrom })
          .map((entry) =>
            entry.id === undefined
              ? { data: entry.data }
              : { id: entry.id, data: entry.data }
          )
      );
      store.copy(from, id, ENGINE);
    });
  }

  /** @internal */
  async enqueue(
    session: ContainerSessionId,
    input: ContainerInput,
    options: ContainerSubmitOptions
  ): Promise<ContainerReceipt> {
    const store = await this.#openStore();
    this.#requireSession(store, session);
    const operationId = options.operationId ?? crypto.randomUUID();
    const meta: OperationMeta = {
      whenBusy: options.whenBusy ?? "followUp",
      delivered: null
    };
    const { accepted } = store.enqueue({
      session,
      id: operationId,
      input: inputJson(input),
      meta: metaJson(meta)
    });
    if (accepted) {
      this.#failures.delete(session);
      // Hand it over now if a socket is open; the wake does it otherwise.
      this.#deliver(store, session);
    }
    await this.#wake(session);
    return { operationId, session, accepted };
  }

  /** @internal Withdraw or abort one operation, or all of a session's. */
  async withdraw(
    session: ContainerSessionId,
    operationId: string | undefined
  ): Promise<boolean> {
    const store = await this.#openStore();
    const targets =
      operationId === undefined
        ? store.operations({ session, status: OPEN })
        : [store.operation(session, operationId)].filter(
            (operation): operation is OperationRecord =>
              operation !== undefined &&
              (operation.status === "queued" || operation.status === "running")
          );
    if (targets.length === 0) return operationId === undefined;
    // The container stops it too; if the socket is closed, the next
    // reconcile aborts whatever the container still runs for it. A
    // session-wide abort is one message, so the container cannot start a
    // queued operation between two per-operation aborts.
    const attached = this.#attached.get(session);
    if (operationId === undefined) {
      attached?.link.send({ type: "abort" });
    } else if (
      targets.some((each) => parseMeta(each.meta).delivered !== null)
    ) {
      attached?.link.send({ type: "abort", operationId });
    }
    for (const operation of targets) {
      this.#settle(store, session, operation.id, {
        status: "unanswered",
        reason: "aborted"
      });
    }
    return true;
  }

  /** @internal Wait for an operation to settle. */
  async settled(
    session: ContainerSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<ContainerOperationResult> {
    const store = await this.#openStore();
    for (;;) {
      const operation = store.operation(session, operationId);
      if (!operation) {
        return {
          operationId,
          session,
          status: "unanswered",
          reason: "not_found"
        };
      }
      const result = resultOf(operation);
      if (result) return result;
      if (signal?.aborted) throw signal.reason;
      await this.#until(
        this.#settleWaiters,
        `${session}\0${operationId}`,
        signal
      );
    }
  }

  /** @internal The active transcript. */
  async transcript(session: ContainerSessionId): Promise<ContainerMessage[]> {
    const store = await this.#openStore();
    const record = this.#requireSession(store, session);
    const state = parseSessionState(record.state);
    return store
      .read(session, MESSAGES, { after: state.messagesFrom })
      .map((entry) => parseMessage(entry.data));
  }

  /** @internal */
  async busy(session: ContainerSessionId): Promise<boolean> {
    const store = await this.#openStore();
    return store.operations({ session, status: OPEN }).length > 0;
  }

  /** @internal Start a new context: a new agent session, without history. */
  async resetSession(
    session: ContainerSessionId,
    handoff: string | undefined
  ): Promise<void> {
    const store = await this.#openStore();
    if (store.operations({ session, status: OPEN }).length > 0) {
      throw new Error(`Container session ${session} is busy; abort it first`);
    }
    store.transaction(() => {
      const state = parseSessionState(
        this.#requireSession(store, session).state
      );
      store.clear(session, ENGINE);
      store.setSessionState(
        session,
        sessionStateJson({
          ...state,
          generation: state.generation + 1,
          messagesFrom: store.end(session, MESSAGES),
          handoff,
          fork: false
        })
      );
    });
    // The next attach opens the new generation.
    this.#detach(session);
  }

  /** @internal */
  async setModel(session: ContainerSessionId, model: string): Promise<void> {
    const store = await this.#openStore();
    const state = parseSessionState(this.#requireSession(store, session).state);
    store.setSessionState(session, sessionStateJson({ ...state, model }));
    this.#attached.get(session)?.link.send({
      type: "configure",
      settings: this.#settings({ ...state, model })
    });
  }

  /** @internal */
  async events(session: ContainerSessionId): Promise<ContainerEventStream> {
    const snapshot: ContainerSessionSnapshot = {
      session,
      messages: await this.transcript(session),
      pending: await this.pending({ session }),
      busy: await this.busy(session)
    };
    let listener:
      | ((events: readonly ContainerSessionEvent[]) => void)
      | undefined;
    return {
      snapshot,
      start: (next) => {
        if (listener) throw new Error("The event stream has already started");
        listener = next;
        let set = this.#listeners.get(session);
        if (!set) {
          set = new Set();
          this.#listeners.set(session, set);
        }
        set.add(next);
      },
      stop: async () => {
        if (listener) this.#listeners.get(session)?.delete(listener);
        listener = undefined;
      }
    };
  }

  // ── The wake ─────────────────────────────────────────────────────────────

  /** Schedule the session's wake job now, or pull it forward. */
  #wake(session: ContainerSessionId, time = Date.now()): Promise<unknown> {
    return this.lifecycle.jobs.push({
      id: wakeJobId(session),
      fn: WAKE_FN,
      time,
      payload: { session },
      singleflight: true,
      recoveryLoop: true
    });
  }

  /**
   * One run of a session's wake job. It never blocks on the container: it
   * hands the drive (start or attach, reconcile, deliver, wait) to the
   * alarm's tracked work and returns a heartbeat. It completes when the
   * session has no open operations.
   */
  async #wakeStep(session: ContainerSessionId): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + this.#heartbeatMs };
    if (this.#waits.has(session)) return heartbeat;
    const store = await this.#openStore();
    if (!store.session(session)) return undefined;
    if (store.operations({ session, status: OPEN }).length === 0) {
      this.#detach(session);
      return undefined;
    }
    const drive = this.#drive(store, session)
      .catch((error: unknown) => {
        this.lifecycle.events.emit("container:drive_error", {
          session,
          error: errorText(error)
        });
        return Date.now() + this.#retryBaseMs;
      })
      .then((next) => {
        this.#waits.delete(session);
        // Re-check at `next`: more work may have arrived, the socket may
        // have closed, or a failed start backs off.
        void this.#wake(session, next);
      });
    this.#waits.set(session, drive);
    // The drive runs past this dispatch, inside the alarm's work, so the
    // object stays alive for it. The heartbeat covers an eviction.
    this.lifecycle.trackAlarmWork(drive);
    return heartbeat;
  }

  /**
   * Attach, deliver, and wait while the session has open work and a live
   * socket. Resolves with when the wake should look again.
   */
  async #drive(
    store: HarnessStore,
    session: ContainerSessionId
  ): Promise<number> {
    const attached = await this.#attach(session);
    if (attached._tag === "err") {
      const failures = (this.#failures.get(session) ?? 0) + 1;
      this.#failures.set(session, failures);
      this.lifecycle.events.emit("container:attach_error", {
        session,
        failures,
        error: attached.error.message
      });
      if (failures < MAX_START_FAILURES) {
        return (
          Date.now() + Math.min(this.#retryBaseMs * 2 ** (failures - 1), 30_000)
        );
      }
      // Give the work up rather than retry forever; the next submit tries again.
      this.#failures.delete(session);
      for (const operation of store.operations({ session, status: OPEN })) {
        this.#settle(store, session, operation.id, {
          status: "unanswered",
          reason: "container_unavailable"
        });
      }
      return Date.now();
    }
    this.#failures.delete(session);
    this.#deliver(store, session);
    await this.#waitForWork(store, session);
    return Date.now();
  }

  /**
   * Resolves when the session has no open work, its socket closed, the
   * container stopped, or the budget ran out.
   */
  async #waitForWork(
    store: HarnessStore,
    session: ContainerSessionId
  ): Promise<void> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.#waitBudgetMs);
    // A container that dies does not always close its sockets promptly;
    // check that it still runs while waiting.
    const watch = setInterval(() => {
      if (!this.#options.container.running) this.#detach(session);
    }, CONTAINER_CHECK_MS);
    try {
      while (
        !budget.signal.aborted &&
        this.#attached.get(session)?.link.open === true &&
        store.operations({ session, status: OPEN }).length > 0
      ) {
        await this.#until(this.#changeWaiters, session, budget.signal);
      }
    } catch {
      // The budget ran out; the heartbeat waits again.
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
    }
  }

  /** The idle stop: destroy the container once nothing has used it for `idleTimeoutMs`. */
  async #idleStep(): Promise<LifecycleJobOutcome> {
    const store = await this.#openStore();
    if (store.operations({ status: OPEN }).length > 0) return undefined;
    const container = this.#options.container;
    if (!container.running) return undefined;
    await this.dispose();
    await container.destroy();
    this.#broadcast({ type: "container", status: "stopped" });
    return undefined;
  }

  async #scheduleIdle(): Promise<void> {
    await this.lifecycle.jobs.push({
      id: IDLE_JOB,
      fn: IDLE_FN,
      time: Date.now() + this.#idleStopMs
    });
  }

  // ── The container ────────────────────────────────────────────────────────

  async #runtimeRecord(): Promise<Runtime | undefined> {
    if (this.#runtime) return this.#runtime;
    await this.lifecycle.ready();
    const stored = await this.lifecycle.storage.get<Runtime>(RUNTIME_KEY);
    this.#runtime = stored;
    return stored;
  }

  /** The running container, started if it is not. Single-flight. */
  #ensureRuntime(): Promise<RuntimeResult> {
    this.#starting ??= this.#doEnsureRuntime().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #doEnsureRuntime(): Promise<RuntimeResult> {
    const container = this.#options.container;
    const port = container.getTcpPort(this.#options.port ?? DAEMON_PORT);
    const known = await this.#runtimeRecord();
    if (container.running && known) {
      if (!this.#timeoutSet) {
        await container.setInactivityTimeout(this.#idleTimeoutMs);
        this.#timeoutSet = true;
      }
      // A container that already runs has had time to boot; one that does
      // not answer soon is replaced rather than waited on for a full start.
      const healthy = await waitHealthy(
        port,
        Math.min(this.#startTimeoutMs, ADOPT_TIMEOUT_MS),
        () => container.running
      );
      if (healthy._tag === "ok") return { _tag: "ok", value: known };
      // Running but not answering: replace it.
      await container.destroy().catch(() => undefined);
    } else if (container.running) {
      // A container this object has no record of cannot be authenticated.
      await container.destroy().catch(() => undefined);
    }
    return this.#launch(container, port);
  }

  async #launch(container: Container, port: Fetcher): Promise<RuntimeResult> {
    const runtime: Runtime = {
      runtimeId: crypto.randomUUID(),
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "")
    };
    // Recorded before the start: a container can outlive this isolate, and
    // its environment cannot be changed once it runs.
    await this.lifecycle.storage.put(RUNTIME_KEY, runtime);
    this.#runtime = runtime;
    this.#broadcast({ type: "container", status: "starting" });
    const launch = this.#options.launch;
    const options = {
      enableInternet: launch.enableInternet,
      env: {
        ...launch.env,
        [CONTAINER_ENV.token]: runtime.token,
        [CONTAINER_ENV.runtimeId]: runtime.runtimeId,
        [CONTAINER_ENV.port]: String(this.#options.port ?? DAEMON_PORT)
      },
      ...(launch.image === undefined ? {} : { image: launch.image }),
      ...(launch.instance === undefined ? {} : { instance: launch.instance }),
      ...(launch.entrypoint === undefined
        ? {}
        : { entrypoint: [...launch.entrypoint] })
    };
    try {
      // SAFETY: `image` and `instance` are start options of the
      // `durable_object` scheduling policy that this workers-types version
      // does not declare yet; the rest is `ContainerStartupOptions` as is.
      container.start(options as ContainerStartupOptions);
      await container.setInactivityTimeout(this.#idleTimeoutMs);
      this.#timeoutSet = true;
    } catch (error) {
      return {
        _tag: "err",
        error: { _tag: "unreachable", message: errorText(error) }
      };
    }
    const healthy = await waitHealthy(
      port,
      this.#startTimeoutMs,
      () => container.running
    );
    if (healthy._tag === "err") {
      await container.destroy().catch(() => undefined);
      return healthy;
    }
    this.#broadcast({ type: "container", status: "ready" });
    return { _tag: "ok", value: runtime };
  }

  // ── Attaching and reconciling ────────────────────────────────────────────

  /** The session's socket, opened and reconciled if it is not. Single-flight. */
  #attach(session: ContainerSessionId): Promise<AttachResult> {
    const attached = this.#attached.get(session);
    if (attached?.link.open)
      return Promise.resolve({ _tag: "ok", value: attached });
    let attaching = this.#attaching.get(session);
    if (!attaching) {
      attaching = this.#doAttach(session).finally(() => {
        this.#attaching.delete(session);
      });
      this.#attaching.set(session, attaching);
    }
    return attaching;
  }

  async #doAttach(session: ContainerSessionId): Promise<AttachResult> {
    const runtime = await this.#ensureRuntime();
    if (runtime._tag === "err") return runtime;
    const port = this.#options.container.getTcpPort(
      this.#options.port ?? DAEMON_PORT
    );
    // Frames can arrive while the link is being set up; they are applied
    // once the reconcile has fixed the cursor.
    let ready: Attached | undefined;
    const early: { seq: number; frame: DaemonFrame }[] = [];
    let caughtUpEarly = false;
    const opened = await DaemonLink.open(port, session, runtime.value.token, {
      frame: (seq, frame) => {
        if (ready) this.#onFrame(session, ready, seq, frame);
        else early.push({ seq, frame });
      },
      caughtUp: () => {
        if (ready) this.#onCaughtUp(session, ready);
        else caughtUpEarly = true;
      },
      closed: () => this.#onClosed(session, ready)
    });
    if (opened._tag === "err") return opened;
    const { link, hello } = opened.value;
    const attached: Attached = {
      link,
      runtimeId: hello.runtimeId,
      sinceAck: 0,
      settledThere: []
    };
    if (hello.runtimeId !== runtime.value.runtimeId) {
      // The token matched, so this is a container this object started; its
      // record was lost or superseded. Adopt the id it reports.
      const adopted = { ...runtime.value, runtimeId: hello.runtimeId };
      await this.lifecycle.storage.put(RUNTIME_KEY, adopted);
      this.#runtime = adopted;
    }
    const store = await this.#openStore();
    this.#reconcile(store, session, attached, hello);
    this.#attached.get(session)?.link.close();
    this.#attached.set(session, attached);
    ready = attached;
    for (const each of early)
      this.#onFrame(session, attached, each.seq, each.frame);
    if (caughtUpEarly) this.#onCaughtUp(session, attached);
    return { _tag: "ok", value: attached };
  }

  /**
   * The replay is complete. Operations the container reported settled in
   * `hello` whose frames it no longer kept are settled from the report now,
   * after every frame it did keep, so their messages land first.
   */
  #onCaughtUp(session: ContainerSessionId, attached: Attached): void {
    const store = this.#store;
    if (!store) return;
    for (const { operationId, outcome } of attached.settledThere.splice(0)) {
      this.#settle(store, session, operationId, outcome);
    }
  }

  /**
   * Make the container's view of a session and the object's agree, before
   * anything is delivered: open the adapter session if the container does
   * not hold it, settle what the container already settled, decide what to
   * do with work a lost container took with it, abort what the container
   * still runs but the object has given up on, and replay missed frames.
   */
  #reconcile(
    store: HarnessStore,
    session: ContainerSessionId,
    attached: Attached,
    hello: Hello
  ): void {
    const { link } = attached;
    let state = parseSessionState(this.#requireSession(store, session).state);
    const sameRuntime = state.cursor?.runtimeId === hello.runtimeId;
    let lostAny = false;

    if (hello.open !== state.generation) {
      const groups = chunkEntries(
        store.read(session, ENGINE).map((entry) => entry.data)
      );
      const last = groups.pop() ?? [];
      for (const entries of groups) {
        link.send({ type: "restore", generation: state.generation, entries });
      }
      link.send({
        type: "open",
        generation: state.generation,
        settings: this.#settings(state),
        restore: last,
        fork: state.fork
      });
    }

    const known = new Map(
      hello.operations.map((operation) => [operation.operationId, operation])
    );
    for (const operation of store.operations({ session, status: OPEN })) {
      const there = known.get(operation.id);
      if (there?.status === "settled") {
        attached.settledThere.push({
          operationId: operation.id,
          outcome: there.outcome
        });
        continue;
      }
      if (there) continue;
      const meta = parseMeta(operation.meta);
      // Only a run that started is lost with its container. One that was
      // handed over but never started is handed to this container instead.
      const lost =
        operation.status === "running" && meta.delivered !== hello.runtimeId;
      if (!lost) {
        // Never started, or handed to this container but it never got it
        // (the socket closed under the send): hand it over again.
        if (meta.delivered !== null) {
          store.setOperationMeta(
            session,
            operation.id,
            metaJson({ ...meta, delivered: null })
          );
        }
        continue;
      }
      lostAny = true;
      if (this.#options.onContainerLost === "retry") {
        store.transaction(() => {
          store.requeue(session, operation.id);
          store.setOperationMeta(
            session,
            operation.id,
            metaJson({ ...meta, delivered: null })
          );
        });
      } else {
        this.#settle(store, session, operation.id, {
          status: "unanswered",
          reason: "container_lost"
        });
      }
    }
    for (const there of hello.operations) {
      if (there.status === "settled") continue;
      const operation = store.operation(session, there.operationId);
      if (
        !operation ||
        operation.status === "done" ||
        operation.status === "unanswered"
      ) {
        link.send({ type: "abort", operationId: there.operationId });
      }
    }

    if (lostAny) this.#emit(session, [{ type: "container", status: "lost" }]);
    if (!sameRuntime) {
      state = { ...state, cursor: { runtimeId: hello.runtimeId, seq: 0 } };
      store.setSessionState(session, sessionStateJson(state));
    }
    link.send({ type: "replay", after: state.cursor?.seq ?? 0 });
  }

  /** Hand every undelivered open operation of the session to the container. */
  #deliver(store: HarnessStore, session: ContainerSessionId): void {
    const attached = this.#attached.get(session);
    if (!attached?.link.open) return;
    for (const operation of store.operations({ session, status: OPEN })) {
      const meta = parseMeta(operation.meta);
      if (meta.delivered === attached.runtimeId) continue;
      let input = parseInput(operation.input);
      const state = parseSessionState(
        this.#requireSession(store, session).state
      );
      if (state.handoff !== undefined)
        input = withHandoff(input, state.handoff);
      const sent = attached.link.send({
        type: "prompt",
        operationId: operation.id,
        input,
        whenBusy: meta.whenBusy
      });
      if (!sent) return;
      store.transaction(() => {
        store.setOperationMeta(
          session,
          operation.id,
          metaJson({ ...meta, delivered: attached.runtimeId })
        );
        if (state.handoff !== undefined) {
          store.setSessionState(
            session,
            sessionStateJson({ ...state, handoff: undefined })
          );
        }
      });
    }
  }

  /** Apply one frame from the container. */
  #onFrame(
    session: ContainerSessionId,
    attached: Attached,
    seq: number,
    frame: DaemonFrame
  ): void {
    const store = this.#store;
    if (!store) return;
    const events: ContainerSessionEvent[] = [];
    let settled: ContainerOperationResult | undefined;
    store.transaction(() => {
      const record = store.session(session);
      if (!record) return;
      let state = parseSessionState(record.state);
      if (
        state.cursor?.runtimeId === attached.runtimeId &&
        seq <= state.cursor.seq
      ) {
        return;
      }
      switch (frame.kind) {
        case "start": {
          if (store.start(session, frame.operationId)) {
            const operation = store.operation(session, frame.operationId);
            if (operation) {
              const message: ContainerMessage = {
                id: `${operation.id}:user`,
                role: "user",
                parts: userParts(parseInput(operation.input)),
                operationId: operation.id,
                createdAt: operation.createdAt
              };
              store.append(session, MESSAGES, [
                { id: message.id, data: messageJson(message) }
              ]);
              events.push({
                type: "message",
                message,
                operationId: operation.id
              });
            }
            events.push({
              type: "operation-start",
              operationId: frame.operationId
            });
          }
          break;
        }
        case "event":
          events.push({ ...frame.event, operationId: frame.operationId });
          if (frame.event.type === "message") {
            store.append(session, MESSAGES, [
              {
                id: frame.event.message.id,
                data: messageJson(frame.event.message)
              }
            ]);
          }
          break;
        case "persist":
          store.append(
            session,
            ENGINE,
            frame.entries.map((data) => ({ data }))
          );
          if (state.fork) state = { ...state, fork: false };
          break;
        case "settle":
          settled = this.#settleInStore(
            store,
            session,
            frame.operationId,
            frame.outcome
          );
          break;
      }
      state = { ...state, cursor: { runtimeId: attached.runtimeId, seq } };
      store.setSessionState(session, sessionStateJson(state));
    });
    if (settled) events.push({ type: "operation-end", result: settled });
    this.#emit(session, events);
    attached.sinceAck += 1;
    if (settled || attached.sinceAck >= ACK_EVERY) {
      attached.sinceAck = 0;
      attached.link.send({ type: "ack", seq });
    }
    if (settled) this.#afterSettle(store, session, settled);
  }

  #onClosed(session: ContainerSessionId, attached: Attached | undefined): void {
    if (attached && this.#attached.get(session) === attached) {
      this.#attached.delete(session);
    }
    this.#notify(this.#changeWaiters, session);
  }

  #detach(session: ContainerSessionId): void {
    const attached = this.#attached.get(session);
    this.#attached.delete(session);
    attached?.link.close();
    this.#notify(this.#changeWaiters, session);
  }

  // ── Settling ─────────────────────────────────────────────────────────────

  #settleInStore(
    store: HarnessStore,
    session: ContainerSessionId,
    operationId: string,
    outcome: ContainerOutcome
  ): ContainerOperationResult | undefined {
    const changed = store.settle(
      session,
      operationId,
      outcome.status === "done"
        ? { status: "done", result: { text: outcome.text } }
        : outcome
    );
    if (!changed) return undefined;
    const operation = store.operation(session, operationId);
    return operation ? resultOf(operation) : undefined;
  }

  /** Settle outside a frame, and tell everyone. */
  #settle(
    store: HarnessStore,
    session: ContainerSessionId,
    operationId: string,
    outcome: ContainerOutcome
  ): void {
    const result = this.#settleInStore(store, session, operationId, outcome);
    if (!result) return;
    this.#emit(session, [{ type: "operation-end", result }]);
    this.#afterSettle(store, session, result);
  }

  #afterSettle(
    store: HarnessStore,
    session: ContainerSessionId,
    result: ContainerOperationResult
  ): void {
    this.#notify(this.#settleWaiters, `${session}\0${result.operationId}`);
    this.#notify(this.#changeWaiters, session);
    if (store.operations({ status: OPEN }).length === 0) {
      void this.#scheduleIdle().catch(() => undefined);
    }
  }

  // ── Small pieces ─────────────────────────────────────────────────────────

  async #openStore(): Promise<HarnessStore> {
    if (this.#store) return this.#store;
    await this.lifecycle.ready();
    if (this.#store) return this.#store;
    const store = openHarnessStore(this.lifecycle.storage, {
      prefix: this.#options.storePrefix ?? "container_"
    });
    store.createSession({
      id: ROOT_SESSION,
      state: sessionStateJson(this.#initial())
    });
    this.#store = store;
    return store;
  }

  #initial(): SessionState {
    return {
      model: this.#options.defaults?.model,
      cursor: null,
      generation: 1,
      messagesFrom: 0,
      handoff: undefined,
      fork: false
    };
  }

  #settings(state: SessionState): ContainerSettings {
    const options = this.#options.defaults?.options;
    return {
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(options === undefined ? {} : { options })
    };
  }

  #requireSession(store: HarnessStore, session: ContainerSessionId) {
    const record = store.session(session);
    if (!record) throw new Error(`Unknown container session ${session}`);
    return record;
  }

  #emit(session: ContainerSessionId, events: readonly ContainerSessionEvent[]) {
    if (events.length === 0) return;
    const listeners = this.#listeners.get(session);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(events);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  #broadcast(event: ContainerSessionEvent): void {
    for (const session of this.#listeners.keys()) this.#emit(session, [event]);
  }

  #notify<K>(waiters: Map<K, Set<() => void>>, key: K): void {
    const set = waiters.get(key);
    waiters.delete(key);
    if (set) for (const wake of set) wake();
  }

  /** Resolve on the next notify for `key`, or reject when `signal` aborts. */
  #until<K>(
    waiters: Map<K, Set<() => void>>,
    key: K,
    signal: AbortSignal | undefined
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let set = waiters.get(key);
      if (!set) {
        set = new Set();
        waiters.set(key, set);
      }
      const onAbort = () => {
        set?.delete(wake);
        reject(signal?.reason);
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      set.add(wake);
    });
  }
}

type RuntimeResult =
  | { readonly _tag: "ok"; readonly value: Runtime }
  | { readonly _tag: "err"; readonly error: LinkError };

type AttachResult =
  | { readonly _tag: "ok"; readonly value: Attached }
  | { readonly _tag: "err"; readonly error: LinkError };

function resultOf(
  operation: OperationRecord
): ContainerOperationResult | undefined {
  const base = { operationId: operation.id, session: operation.session };
  if (operation.status === "done") {
    const result = operation.result;
    const text =
      isRecord(result) && typeof result.text === "string" ? result.text : "";
    return { ...base, status: "done", text };
  }
  if (operation.status === "unanswered") {
    return {
      ...base,
      status: "unanswered",
      reason: operation.reason ?? "unanswered"
    };
  }
  return undefined;
}

/** One session, addressed through the harness. */
export class ContainerSession {
  readonly #harness: ContainerHarness;
  /** The session id. */
  readonly id: ContainerSessionId;

  /**
   * @param harness - The harness.
   * @param id - The session id.
   */
  constructor(harness: ContainerHarness, id: ContainerSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  /**
   * Durably submit a prompt. Resolves before the agent runs.
   *
   * @param input - The prompt.
   * @param options - Idempotency key and busy behaviour.
   * @returns The receipt.
   */
  submit(
    input: ContainerInput,
    options: ContainerSubmitOptions = {}
  ): Promise<ContainerReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  /**
   * Submit and wait for the answer and the updated transcript.
   *
   * @param input - The prompt.
   * @param options - Idempotency key and busy behaviour.
   * @returns The result, with the transcript after it.
   */
  async prompt(
    input: ContainerInput,
    options: ContainerSubmitOptions = {}
  ): Promise<ContainerPromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /**
   * Join the running turn, when the adapter can steer; otherwise queue.
   *
   * @param input - The prompt.
   * @param options - Idempotency key.
   * @returns The receipt.
   */
  steer(
    input: ContainerInput,
    options: Omit<ContainerSubmitOptions, "whenBusy"> = {}
  ): Promise<ContainerReceipt> {
    return this.submit(input, { ...options, whenBusy: "steer" });
  }

  /**
   * Wait for an operation to settle. Aborting `signal` stops only the wait.
   *
   * @param operationId - The operation.
   * @param signal - Stops the wait.
   * @returns How it ended.
   */
  wait(
    operationId: string,
    signal?: AbortSignal
  ): Promise<ContainerOperationResult> {
    return this.#harness.settled(this.id, operationId, signal);
  }

  /**
   * Withdraw or abort one operation, or, with no id, every open operation
   * of the session. Aborted operations settle `unanswered` with `aborted`.
   *
   * @param operationId - The operation. Default: all of them.
   * @returns Whether anything was open to abort (always true with no id).
   */
  abort(operationId?: string): Promise<boolean> {
    return this.#harness.withdraw(this.id, operationId);
  }

  /**
   * Start a new context: a new agent session without the old history,
   * optionally seeded with a handoff note prepended to the next prompt.
   * Throws while the session is busy.
   *
   * @param handoff - The note.
   */
  reset(handoff?: string): Promise<void> {
    return this.#harness.resetSession(this.id, handoff);
  }

  /**
   * Change this session's model, by the adapter's model name.
   *
   * @param model - The model.
   */
  setModel(model: string): Promise<void> {
    return this.#harness.setModel(this.id, model);
  }

  /**
   * The active transcript, since the newest reset.
   *
   * @returns The messages, oldest first.
   */
  messages(): Promise<ContainerMessage[]> {
    return this.#harness.transcript(this.id);
  }

  /**
   * This session's events: a snapshot, then live batches.
   *
   * @returns The stream.
   */
  events(): Promise<ContainerEventStream> {
    return this.#harness.events(this.id);
  }

  /**
   * Whether the session has open operations.
   *
   * @returns True while anything is queued or running.
   */
  busy(): Promise<boolean> {
    return this.#harness.busy(this.id);
  }
}

/** Every session in this object. */
export class ContainerSessions {
  readonly #harness: ContainerHarness;

  /**
   * @param harness - The harness.
   */
  constructor(harness: ContainerHarness) {
    this.#harness = harness;
  }

  /**
   * A handle on one session.
   *
   * @param id - The session id.
   * @returns The handle.
   */
  get(id: ContainerSessionId): ContainerSession {
    return this.#harness.session(id);
  }

  /**
   * A new top-level session, with the harness's defaults.
   *
   * @returns The new session.
   */
  async create(): Promise<ContainerSession> {
    const id = crypto.randomUUID();
    await this.#harness.createSession(id);
    return this.#harness.session(id);
  }

  /**
   * A new session that continues `from`'s history as a branch.
   *
   * @param from - The session to fork.
   * @returns The new session.
   */
  async fork(from: ContainerSessionId): Promise<ContainerSession> {
    const id = crypto.randomUUID();
    await this.#harness.createSession(id, from);
    return this.#harness.session(id);
  }

  /**
   * Every session, oldest first.
   *
   * @returns Each session's id, parent, and whether it is busy.
   */
  async list(): Promise<ContainerSessionInfo[]> {
    const store = await this.#harness.store();
    const busy = new Set(
      store.operations({ status: OPEN }).map((operation) => operation.session)
    );
    return store.sessions().map((record) => ({
      id: record.id,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      busy: busy.has(record.id)
    }));
  }
}
