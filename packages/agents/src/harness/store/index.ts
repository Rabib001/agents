/**
 * A harness-agnostic session store on a Durable Object's SQLite database:
 * sessions, operations, and named logs of opaque JSON per session. Any
 * harness that runs its agent outside the object can keep its durable
 * record here, in whatever format it speaks.
 *
 * @beta The API may change between releases.
 */
export {
  HarnessStore,
  openHarnessStore,
  type HarnessStoreOptions,
  type JsonValue,
  type LogAppend,
  type LogEntry,
  type OperationOutcome,
  type OperationRecord,
  type OperationStatus,
  type SessionRecord
} from "./store";
