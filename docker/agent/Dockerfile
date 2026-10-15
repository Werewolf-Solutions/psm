FROM node:22-bookworm-slim

# Commands are free inside a job container, so include the ordinary development
# tools a coding agent expects. The running container has no package network.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq make gcc g++ pkg-config python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
