#!/usr/bin/env bash
# Clones the factory into /workspace, the container's own volume, on the container's first start (incident-platform
# backlog #0-269). The repository is public, so the clone needs no token; a push does, and gets the app's. Later starts
# find the clone and leave it as it is. A clone cut off halfway leaves a .git with no commit: that start, and every
# later one, stops and says so instead of passing it for a clone (review round 3).
set -euo pipefail
if [ -e /workspace/.git ]; then
    if git -C /workspace rev-parse --verify --quiet HEAD >/dev/null; then
        exit 0
    fi
    echo "factory-workspace: /workspace holds an incomplete clone; remove the volume (docker volume rm factory-dev-workspace) and start again" >&2
    exit 1
fi
git clone https://github.com/profitbuild/factory.git /workspace
