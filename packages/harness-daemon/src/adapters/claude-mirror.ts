/**
 * Claude Code's transcript mirror: the Agent SDK's `SessionStore`, backed by
 * the Durable Object instead of the container's disk.
 */

import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "agents/harness/container/daemon";

/** One mirrored batch, as persisted. */
export type MirrorBatch = {
  readonly sessionId: string;
  readonly subpath: string | null;
  readonly entries: readonly SessionStoreEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBatch(value: JsonValue): MirrorBatch | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  if (!Array.isArray(value.entries)) return undefined;
  const subpath = typeof value.subpath === "string" ? value.subpath : null;
  const entries = value.entries.filter(
    (entry): entry is SessionStoreEntry =>
      isRecord(entry) && typeof entry.type === "string"
  );
  return { sessionId: value.sessionId, subpath, entries };
}

/**
 * The SDK's transcript store, backed by the Durable Object: `append`
 * persists, `load` answers from what was restored plus what this process
 * appended since.
 */
export class MirrorStore implements SessionStore {
  readonly #transcripts = new Map<string, SessionStoreEntry[]>();
  readonly #persist: (batch: MirrorBatch) => void;
  #lastSession: string | undefined;

  constructor(
    restore: readonly JsonValue[],
    persist: (batch: MirrorBatch) => void
  ) {
    this.#persist = persist;
    for (const value of restore) {
      const batch = parseBatch(value);
      if (batch) this.#add(batch);
    }
  }

  /** The newest main-transcript session, the one to resume. */
  get lastSession(): string | undefined {
    return this.#lastSession;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const batch: MirrorBatch = {
      sessionId: key.sessionId,
      subpath: key.subpath ?? null,
      entries
    };
    this.#add(batch);
    this.#persist(batch);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return (
      this.#transcripts.get(this.#key(key.sessionId, key.subpath ?? null)) ??
      null
    );
  }

  async listSubkeys(key: { sessionId: string }): Promise<string[]> {
    const prefix = `${key.sessionId}\0`;
    return [...this.#transcripts.keys()]
      .filter((each) => each.startsWith(prefix) && each.length > prefix.length)
      .map((each) => each.slice(prefix.length));
  }

  #add(batch: MirrorBatch): void {
    const key = this.#key(batch.sessionId, batch.subpath);
    const existing = this.#transcripts.get(key) ?? [];
    const seen = new Set(
      existing.flatMap((entry) => (entry.uuid ? [entry.uuid] : []))
    );
    for (const entry of batch.entries) {
      if (entry.uuid && seen.has(entry.uuid)) continue;
      existing.push(entry);
    }
    this.#transcripts.set(key, existing);
    if (batch.subpath === null) this.#lastSession = batch.sessionId;
  }

  #key(sessionId: string, subpath: string | null): string {
    return `${sessionId}\0${subpath ?? ""}`;
  }
}
