import { ContainerDaemon, type ContainerAdapter } from "../daemon-core";
import {
  CLOSE_UNAUTHORIZED,
  CONTAINER_ENV,
  CONTAINER_HEALTH_PATH,
  CONTAINER_SESSION_PATH,
  CONTAINER_TOKEN_HEADER
} from "../protocol";

/**
 * A stand-in for `ctx.container` that runs the real daemon core in the
 * test isolate, served over `WebSocketPair`s. It behaves like the platform
 * where the harness can tell: `start()` is synchronous and the daemon
 * answers health checks at once, a new start is a new process (a new
 * daemon, with nothing in memory), and the container lives in module
 * state, so it outlives an aborted Durable Object instance the way a real
 * container outlives its object's eviction.
 */
export class FakeContainer {
  starts = 0;
  inactivityTimeoutMs: number | undefined;
  lastEnv: Record<string, string> = {};
  /** When set, `start()` throws, as a bad image or a full account would. */
  failStarts = false;
  #daemon: ContainerDaemon | undefined;
  #token = "";
  #sockets = new Set<WebSocket>();
  readonly #adapter: ContainerAdapter;

  constructor(adapter: ContainerAdapter) {
    this.#adapter = adapter;
  }

  get running(): boolean {
    return this.#daemon !== undefined;
  }

  start(options?: { env?: Record<string, string> }): void {
    if (this.failStarts) throw new Error("no capacity");
    const env = options?.env ?? {};
    this.starts += 1;
    this.lastEnv = { ...env };
    this.#token = env[CONTAINER_ENV.token] ?? "";
    this.#daemon = new ContainerDaemon({
      adapter: this.#adapter,
      runtimeId: env[CONTAINER_ENV.runtimeId] ?? "unknown"
    });
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.inactivityTimeoutMs = Number(ms);
  }

  async destroy(): Promise<void> {
    const daemon = this.#daemon;
    this.#daemon = undefined;
    for (const socket of this.#sockets) {
      try {
        socket.close(1011, "container stopped");
      } catch {
        // Already closed, or owned by an aborted object.
      }
    }
    this.#sockets.clear();
    await daemon?.close();
  }

  /** The container dies under the object, as a crash or a host failure would. */
  crash(): Promise<void> {
    return this.destroy();
  }

  getTcpPort(_port: number): Fetcher {
    // As on the platform, a port belongs to the instance that ran when it
    // was taken: one taken before `start()` reaches no instance.
    const bound = this.#daemon;
    const fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const daemon = this.#daemon;
        if (!daemon || daemon !== bound) {
          throw new Error(
            "There is no container instance that can be provided to this Durable Object"
          );
        }
        const url = new URL(request.url);
        if (url.pathname === CONTAINER_HEALTH_PATH) {
          return new Response("ok");
        }
        if (!url.pathname.startsWith(CONTAINER_SESSION_PATH)) {
          return new Response("not found", { status: 404 });
        }
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        server.accept();
        if (request.headers.get(CONTAINER_TOKEN_HEADER) !== this.#token) {
          server.close(CLOSE_UNAUTHORIZED, "unauthorized");
          return new Response(null, { status: 101, webSocket: client });
        }
        this.#sockets.add(server);
        const session = decodeURIComponent(
          url.pathname.slice(CONTAINER_SESSION_PATH.length)
        );
        const connection = daemon.connect(session, {
          send: (text) => server.send(text),
          close: (code, reason) => {
            try {
              server.close(code, reason);
            } catch {
              // Owned by an aborted object.
            }
          }
        });
        server.addEventListener("message", (event) => {
          connection.receive(
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data)
          );
        });
        server.addEventListener("close", () => {
          this.#sockets.delete(server);
          connection.closed();
        });
        return new Response(null, { status: 101, webSocket: client });
      }
    };
    // SAFETY: the harness calls only `fetch` on a container port.
    return fetcher as unknown as Fetcher;
  }

  /** This fake, typed as the platform's container for the harness. */
  asContainer(): Container {
    // SAFETY: the harness uses only `running`, `start`, `destroy`,
    // `getTcpPort` and `setInactivityTimeout`, all implemented above.
    return this as unknown as Container;
  }
}

const containers = new Map<string, FakeContainer>();

/**
 * The fake container for one object, kept across object restarts.
 *
 * @param id - The object's id.
 * @param adapter - The adapter its daemon runs.
 * @returns The container.
 */
export function containerFor(
  id: DurableObjectId,
  adapter: ContainerAdapter
): FakeContainer {
  const key = id.toString();
  let container = containers.get(key);
  if (!container) {
    container = new FakeContainer(adapter);
    containers.set(key, container);
  }
  return container;
}
