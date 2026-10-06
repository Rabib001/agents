/**
 * The image entrypoint for the built-in adapters. `CF_HARNESS_ADAPTER`
 * picks one: `claude-code` (default), `codex`, or `echo` (no model, for
 * smoke tests). For another CLI, write an entrypoint of your own with
 * `serveFromEnv(cliAdapter({ ... }))`.
 */

import {
  echoAdapter,
  type ContainerAdapter
} from "agents/harness/container/daemon";
import { claudeCode } from "./presets/claude-code";
import { codex } from "./presets/codex";
import { serveFromEnv } from "./server";

const adapters: { readonly [name: string]: ContainerAdapter } = {
  "claude-code": claudeCode,
  codex,
  echo: echoAdapter
};

const name = process.env.CF_HARNESS_ADAPTER ?? "claude-code";
const adapter = adapters[name];
if (!adapter) {
  console.error(`harness-daemon: unknown CF_HARNESS_ADAPTER ${name}`);
  process.exit(1);
}
await serveFromEnv(adapter).catch((error: unknown) => {
  console.error(`harness-daemon: ${String(error)}`);
  process.exit(1);
});
