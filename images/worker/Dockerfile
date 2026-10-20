# Base image for task sandboxes. Repo images should build FROM this (or include the same
# tools): git, coreutils `timeout`, util-linux `setsid`, procps `kill`, and the harness.
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=2.1.304
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Keep Claude Code from calling home for anything but the model API.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1
WORKDIR /workspace
