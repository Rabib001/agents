import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CLOSE_UNAUTHORIZED,
  CONTAINER_TOKEN_HEADER,
  echoAdapter,
  parseDaemonMessage,
  type DaemonMessage,
  type HostMessage
} from "agents/harness/container/daemon";
import { serve, type DaemonServer } from "../server";

const TOKEN = "secret-token";
let server: DaemonServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A client that collects every message the daemon sends. */
async function connect(port: number, session: string, token = TOKEN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${session}`, {
    headers: { [CONTAINER_TOKEN_HEADER]: token }
  });
  const received: DaemonMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data) => {
    const message = parseDaemonMessage(data.toString());
    if (message) received.push(message);
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<number>((resolve) =>
    ws.on("close", (code) => resolve(code))
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    received,
    closed,
    send: (message: HostMessage) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
    async until(check: (messages: DaemonMessage[]) => boolean) {
      while (!check(received)) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    }
  };
}

function settled(messages: DaemonMessage[], operationId: string) {
  return messages.some(
    (m) =>
      m.type === "frame" &&
      m.frame.kind === "settle" &&
      m.frame.operationId === operationId
  );
}

describe("harness daemon over ws", () => {
  it("answers the health check without a token", async () => {
    server = await serve({
      adapter: echoAdapter,
      runtimeId: "r1",
      token: TOKEN,
      port: 0
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
  });

  it("refuses a session socket with the wrong token", async () => {
    server = await serve({
      adapter: echoAdapter,
      runtimeId: "r1",
      token: TOKEN,
      port: 0
    });
    const client = await connect(server.port, "s", "wrong");
    expect(await client.closed).toBe(CLOSE_UNAUTHORIZED);
    expect(client.received).toEqual([]);
  });

  it("greets, opens, runs a prompt, and replays from a cursor on reconnect", async () => {
    server = await serve({
      adapter: echoAdapter,
      runtimeId: "r1",
      token: TOKEN,
      port: 0
    });
    const first = await connect(server.port, "s");
    await first.until((m) => m.length > 0);
    expect(first.received[0]).toMatchObject({
      type: "hello",
      runtimeId: "r1",
      session: "s",
      open: null,
      lastSeq: 0,
      adapter: { id: "echo" }
    });

    first.send({
      type: "restore",
      generation: 1,
      entries: [{ turn: 1 }]
    });
    first.send({
      type: "open",
      generation: 1,
      settings: {},
      restore: [{ turn: 2 }]
    });
    first.send({ type: "replay", after: 0 });
    first.send({
      type: "prompt",
      operationId: "op",
      input: "hi",
      whenBusy: "followUp"
    });
    await first.until((m) => settled(m, "op"));
    const frames = first.received.flatMap((m) =>
      m.type === "frame" ? [m] : []
    );
    expect(frames.map((f) => f.frame.kind)).toEqual([
      "start",
      "event",
      "event",
      "persist",
      "settle"
    ]);
    // Restored from two entries, so this is the third turn.
    expect(frames.at(-1)?.frame).toMatchObject({
      outcome: { status: "done", text: "echo: hi (turn 3)" }
    });
    first.close();

    const second = await connect(server.port, "s");
    await second.until((m) => m.length > 0);
    expect(second.received[0]).toMatchObject({
      type: "hello",
      open: 1,
      lastSeq: 5,
      operations: [
        { operationId: "op", status: "settled", outcome: { status: "done" } }
      ]
    });
    second.send({ type: "replay", after: 3 });
    await second.until((m) => m.some((x) => x.type === "caught-up"));
    expect(
      second.received.flatMap((m) => (m.type === "frame" ? [m.seq] : []))
    ).toEqual([4, 5]);
  });
});
