import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../../../lifecycle";
import { echoAdapter, type ContainerAdapter } from "../daemon-core";
import { setWakeTimingForTests } from "../harness";
import { inputText } from "../protocol";
import {
  ContainerHarness,
  type ContainerMessage,
  type ContainerOperationResult,
  type ContainerReceipt,
  type ContainerSessionEvent,
  type ContainerSubmitOptions
} from "../index";
import { containerFor, type FakeContainer } from "./fake-container";

export { HarnessStoreTestObject } from "./store-fixture";

/**
 * The echo adapter, plus probes: `model?` answers the session's model,
 * `fork?` whether the session opened as a fork and how many entries it was
 * restored from, `bulk <n>` persists `n` entries of 10 kB, and `restored?`
 * how many entries the session was restored from.
 */
const testAdapter: ContainerAdapter = {
  id: "test",
  version: "1",
  capabilities: echoAdapter.capabilities ?? [],
  async open(context) {
    const echo = await echoAdapter.open(context);
    let model = context.settings.model;
    return {
      ...echo,
      async run(turn) {
        const text = inputText(turn.input);
        if (text === "model?") return { status: "done", text: model ?? "none" };
        const bulk = /^bulk (\d+)$/.exec(text);
        if (bulk) {
          const filler = "x".repeat(10_000);
          context.persist(
            Array.from({ length: Number(bulk[1]) }, (_, i) => ({ i, filler }))
          );
          return { status: "done", text: "stored" };
        }
        if (text === "restored?") {
          return { status: "done", text: String(context.restore.length) };
        }
        if (text === "fork?") {
          return {
            status: "done",
            text: `${context.fork} ${context.restore.length}`
          };
        }
        return echo.run(turn);
      },
      configure(settings) {
        model = settings.model;
      }
    };
  }
};

const IDLE_MS = 60_000;

function texts(messages: readonly ContainerMessage[]): string[] {
  return messages.map((message) =>
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
  );
}

/** A harness over the fake container, with the given policy for lost work. */
function makeHarness(
  container: FakeContainer,
  onContainerLost: "fail" | "retry"
): ContainerHarness {
  const harness = new ContainerHarness({
    container: container.asContainer(),
    launch: { image: "test-image", enableInternet: false },
    idleTimeoutMs: IDLE_MS,
    startTimeoutMs: 1_000,
    defaults: { model: "small" },
    onContainerLost
  });
  setWakeTimingForTests(harness, { heartbeatMs: 1_000, retryBaseMs: 50 });
  return harness;
}

/** Real Durable Object fixture: a container harness over a fake container. */
export class ContainerHarnessTestObject extends DurableObject<Cloudflare.Env> {
  readonly fake = containerFor(this.ctx.id, testAdapter);
  readonly harness = makeHarness(this.fake, this.policy());
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  policy(): "fail" | "retry" {
    return "fail";
  }

  async prompt(text: string, session?: string) {
    const response = await this.harness.prompt(
      text,
      session ? { session } : {}
    );
    return { ...response, messages: texts(response.messages) };
  }

  submit(
    text: string,
    options: ContainerSubmitOptions = {}
  ): Promise<ContainerReceipt> {
    return this.harness.submit(text, options);
  }

  wait(
    operationId: string,
    session?: string
  ): Promise<ContainerOperationResult> {
    return this.harness.wait(operationId, session ? { session } : {});
  }

  async messages(session?: string): Promise<string[]> {
    return texts(await this.harness.messages(session ? { session } : {}));
  }

  pending(session?: string) {
    return this.harness.pending(session ? { session } : {});
  }

  abort(operationId?: string, session?: string): Promise<boolean> {
    return this.harness.abort({
      ...(operationId === undefined ? {} : { operationId }),
      ...(session === undefined ? {} : { session })
    });
  }

  async createSession(): Promise<string> {
    return (await this.harness.sessions.create()).id;
  }

  async forkSession(from: string): Promise<string> {
    return (await this.harness.sessions.fork(from)).id;
  }

  listSessions() {
    return this.harness.sessions.list();
  }

  /** Reset, returning the error message instead of throwing across RPC. */
  async reset(handoff?: string, session?: string): Promise<string | undefined> {
    try {
      await this.harness.session(session).reset(handoff);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  setModel(model: string): Promise<void> {
    return this.harness.session().setModel(model);
  }

  busy(): Promise<boolean> {
    return this.harness.session().busy();
  }

  /** Collect the root session's events until `count` operations end. */
  async watch(count: number): Promise<string[]> {
    const stream = await this.harness.session().events();
    const types: string[] = [];
    let ended = 0;
    await new Promise<void>((resolve) => {
      stream.start((events: readonly ContainerSessionEvent[]) => {
        for (const event of events) {
          if (event.type === "container") continue;
          types.push(event.type);
          if (event.type === "operation-end") ended += 1;
        }
        if (ended >= count) resolve();
      });
    });
    await stream.stop();
    return types;
  }

  /** Resolve once an operation has started running in the container. */
  async running(operationId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const pending = await this.harness.pending();
      if (
        pending.some(
          (each) =>
            each.operationId === operationId && each.status === "running"
        )
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${operationId} never started`);
  }

  container() {
    return {
      running: this.fake.running,
      starts: this.fake.starts,
      inactivityTimeoutMs: this.fake.inactivityTimeoutMs,
      env: this.fake.lastEnv
    };
  }

  /** Close the session sockets, as a network blip would. The container keeps working. */
  dropSockets(): Promise<void> {
    return this.harness.dispose();
  }

  crashContainer(): Promise<void> {
    return this.fake.crash();
  }

  failStarts(fail: boolean): void {
    this.fake.failStarts = fail;
  }

  stopContainer(): Promise<void> {
    return this.harness.stop();
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Make the idle stop fire `ms` after the last work, instead of a minute. */
  shortenIdle(ms: number): void {
    setWakeTimingForTests(this.harness, { idleStopMs: ms });
  }
}

/** The same fixture with `onContainerLost: "retry"`. */
export class ContainerRetryTestObject extends ContainerHarnessTestObject {
  override policy(): "fail" | "retry" {
    return "retry";
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
