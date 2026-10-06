import { describe, expect, it } from "vitest";
import type { JsonValue } from "agents/harness/container/daemon";
import { MirrorStore, type MirrorBatch } from "../adapters/claude-mirror";

const KEY = { projectKey: "-workspace", sessionId: "s1" };

describe("MirrorStore", () => {
  it("persists every append and loads it back in a new store", async () => {
    const persisted: MirrorBatch[] = [];
    const first = new MirrorStore([], (batch) => persisted.push(batch));
    expect(first.lastSession).toBeUndefined();
    await first.append(KEY, [{ type: "user", uuid: "a" }]);
    await first.append({ ...KEY, subpath: "subagents/x" }, [
      { type: "user", uuid: "b" }
    ]);
    await first.append(KEY, [{ type: "assistant", uuid: "c" }]);
    expect(persisted).toHaveLength(3);

    // SAFETY: test fixtures are plain JSON.
    const restore = persisted as unknown as JsonValue[];
    const second = new MirrorStore(restore, () => {});
    expect(second.lastSession).toBe("s1");
    expect(await second.load(KEY)).toEqual([
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "c" }
    ]);
    expect(await second.listSubkeys(KEY)).toEqual(["subagents/x"]);
    expect(await second.load({ ...KEY, sessionId: "other" })).toBeNull();
  });

  it("dedupes entries by uuid and keeps entries without one", async () => {
    const store = new MirrorStore([], () => {});
    await store.append(KEY, [{ type: "user", uuid: "a" }, { type: "title" }]);
    await store.append(KEY, [{ type: "user", uuid: "a" }, { type: "title" }]);
    expect(await store.load(KEY)).toEqual([
      { type: "user", uuid: "a" },
      { type: "title" },
      { type: "title" }
    ]);
  });

  it("resumes the newest main transcript, as after a fork", async () => {
    const restore: JsonValue[] = [
      { sessionId: "parent", subpath: null, entries: [{ type: "user" }] },
      { sessionId: "branch", subpath: null, entries: [{ type: "user" }] },
      {
        sessionId: "branch",
        subpath: "subagents/x",
        entries: [{ type: "user" }]
      }
    ];
    expect(new MirrorStore(restore, () => {}).lastSession).toBe("branch");
  });
});
