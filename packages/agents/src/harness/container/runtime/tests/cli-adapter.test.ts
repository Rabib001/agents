import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerEvent, JsonValue } from "../../protocol";
import type { AdapterContext } from "../../daemon-core";
import { cliAdapter } from "../cli-adapter";

const FAKE = join(import.meta.dirname, "fake-cli.mjs");

/** The fake CLI as an adapter, with session homes under `homes`. */
function fakeAdapter(homes: string) {
  return cliAdapter({
    id: "fake",
    stateDirs: [".fake/sessions"],
    cwd: tmpdir(),
    homes,
    command: (turn) => ({
      argv: [
        process.execPath,
        FAKE,
        ...(turn.state.id ? ["--resume", turn.state.id] : [])
      ],
      stdin: turn.prompt
    }),
    parser: () => ({
      line(text) {
        const line = JSON.parse(text) as {
          type: string;
          id?: string;
          text?: string;
        };
        if (line.type === "session" && line.id)
          return { state: { id: line.id } };
        if (line.type === "text") {
          return {
            events: [
              { type: "text-delta", messageId: "m", delta: line.text ?? "" }
            ],
            outcome: { status: "done", text: line.text ?? "" }
          };
        }
        return {};
      },
      end: ({ code }) => ({ status: "unanswered", reason: `exit ${code}` })
    })
  });
}

/** An adapter context that records what the adapter emits and persists. */
function recorder(session: string, restore: readonly JsonValue[] = []) {
  const events: ContainerEvent[] = [];
  const persisted: JsonValue[] = [];
  const context: AdapterContext = {
    session,
    settings: {},
    restore,
    emit: (event) => events.push(event),
    persist: (entries) => persisted.push(...entries),
    log: () => {}
  };
  return { context, events, persisted };
}

function turn(
  operationId: string,
  input: string,
  signal = new AbortController().signal
) {
  return { operationId, input, signal };
}

describe("cliAdapter", () => {
  it("runs a turn per process, resumes by state, and persists both", async () => {
    const adapter = fakeAdapter(await mkdtemp(join(tmpdir(), "homes-")));
    const { context, events, persisted } = recorder("s");
    const session = await adapter.open(context);
    expect(await session.run(turn("op1", "hello"))).toEqual({
      status: "done",
      text: "turn 1: hello"
    });
    expect(await session.run(turn("op2", "again"))).toEqual({
      status: "done",
      text: "turn 2: again"
    });
    expect(events).toContainEqual({
      type: "text-delta",
      messageId: "m",
      delta: "turn 1: hello"
    });
    // The CLI's session id once, then the file's growth per turn.
    expect(
      persisted.filter((e) => (e as { kind: string }).kind === "state")
    ).toHaveLength(1);
    const files = persisted.filter(
      (e) => (e as { kind: string }).kind === "file"
    );
    expect(files.map((e) => (e as { offset: number }).offset)).toEqual([
      0,
      Buffer.byteLength('{"prompt":"hello"}\n')
    ]);
  });

  it("resumes the CLI's session in a new container from what it persisted", async () => {
    const first = recorder("s");
    const old = await fakeAdapter(await mkdtemp(join(tmpdir(), "homes-"))).open(
      first.context
    );
    await old.run(turn("op1", "one"));
    await old.run(turn("op2", "two"));

    // A new container: an empty disk, and only what was persisted.
    const next = recorder("s", first.persisted);
    const resumed = await fakeAdapter(
      await mkdtemp(join(tmpdir(), "homes-"))
    ).open(next.context);
    expect(await resumed.run(turn("op3", "three"))).toEqual({
      status: "done",
      text: "turn 3: three"
    });
  });

  it("gives sessions in one container separate homes", async () => {
    const adapter = fakeAdapter(await mkdtemp(join(tmpdir(), "homes-")));
    const a = await adapter.open(recorder("a").context);
    const b = await adapter.open(recorder("b").context);
    await a.run(turn("1", "x"));
    await a.run(turn("2", "y"));
    expect(await b.run(turn("3", "z"))).toMatchObject({ text: "turn 1: z" });
  });

  it("starts over after a reset: an open without restore forgets the old session", async () => {
    const homes = await mkdtemp(join(tmpdir(), "homes-"));
    const first = recorder("s");
    await (await fakeAdapter(homes).open(first.context)).run(turn("1", "x"));
    const reset = recorder("s");
    const fresh = await fakeAdapter(homes).open(reset.context);
    expect(await fresh.run(turn("2", "y"))).toMatchObject({
      text: "turn 1: y"
    });
  });

  it("reports a CLI that exits without an outcome", async () => {
    const session = await fakeAdapter(
      await mkdtemp(join(tmpdir(), "homes-"))
    ).open(recorder("s").context);
    expect(await session.run(turn("1", "crash"))).toEqual({
      status: "unanswered",
      reason: "exit 3"
    });
  });

  it("interrupts the CLI on abort", async () => {
    const session = await fakeAdapter(
      await mkdtemp(join(tmpdir(), "homes-"))
    ).open(recorder("s").context);
    const controller = new AbortController();
    const running = session.run(turn("1", "sleep", controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    expect(await running).toEqual({ status: "unanswered", reason: "aborted" });
  });
});
