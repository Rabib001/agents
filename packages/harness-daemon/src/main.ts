/**
 * The container's entrypoint: read the environment the Durable Object
 * started the container with, pick the adapter, and serve until SIGTERM.
 *
 * - `CF_HARNESS_TOKEN`, `CF_HARNESS_RUNTIME_ID`, `CF_HARNESS_PORT`: set by
 *   `ContainerHarness` on every start.
 * - `CF_HARNESS_ADAPTER`: `claude-code` (default) or `echo`, set in the
 *   image or in the harness's `launch.env`.
 */

import { echoAdapter, CONTAINER_ENV } from "agents/harness/container/daemon";
import type { ContainerAdapter } from "agents/harness/container/daemon";
import { claudeCode } from "./adapters/claude-code";
import { serve } from "./server";

type Config = {
  readonly token: string;
  readonly runtimeId: string;
  readonly port: number;
  readonly adapter: ContainerAdapter;
};

type ConfigResult =
  | { readonly _tag: "ok"; readonly value: Config }
  | { readonly _tag: "err"; readonly message: string };

function parseConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const token = env[CONTAINER_ENV.token];
  const runtimeId = env[CONTAINER_ENV.runtimeId];
  const port = Number(env[CONTAINER_ENV.port] ?? "8080");
  if (!token)
    return { _tag: "err", message: `${CONTAINER_ENV.token} is not set` };
  if (!runtimeId) {
    return { _tag: "err", message: `${CONTAINER_ENV.runtimeId} is not set` };
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { _tag: "err", message: `${CONTAINER_ENV.port} is not a port` };
  }
  const name = env.CF_HARNESS_ADAPTER ?? "claude-code";
  const adapter =
    name === "echo"
      ? echoAdapter
      : name === "claude-code"
        ? claudeCode()
        : undefined;
  if (!adapter) {
    return { _tag: "err", message: `Unknown CF_HARNESS_ADAPTER ${name}` };
  }
  return { _tag: "ok", value: { token, runtimeId, port, adapter } };
}

const config = parseConfig(process.env);
if (config._tag === "err") {
  console.error(`harness-daemon: ${config.message}`);
  process.exit(1);
}
const { token, runtimeId, port, adapter } = config.value;
// The token has done its job once it is in memory; the agent's tools run
// arbitrary commands and need not see it.
delete process.env[CONTAINER_ENV.token];

const server = await serve({ adapter, runtimeId, token, port });
console.log(
  `harness-daemon: ${adapter.id} listening on ${server.port} (runtime ${runtimeId})`
);

const shutdown = async () => {
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
