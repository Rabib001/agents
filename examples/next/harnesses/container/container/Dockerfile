# The harness daemon with both CLIs. `pnpm run build:daemon` bundles
# @cloudflare/harness-daemon into harness-daemon.mjs next to this file;
# CF_HARNESS_ADAPTER (set by the object) picks the CLI it runs.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Pinned: the adapters parse each CLI's JSON output.
RUN npm install -g @anthropic-ai/claude-code@2.1.289 @openai/codex@0.157.0

COPY harness-daemon.mjs /app/harness-daemon.mjs

# Claude Code refuses to skip permissions as root; the container is the
# sandbox, so run as an unprivileged user that owns the workspace.
RUN useradd --create-home --uid 10001 agent \
  && mkdir -p /workspace \
  && chown agent:agent /workspace
USER agent
WORKDIR /workspace

ENV DISABLE_AUTOUPDATER=1
EXPOSE 8080
ENTRYPOINT ["node", "/app/harness-daemon.mjs"]
