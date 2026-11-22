# ============================================================
# The devcontainer where a session writes the factory's code (incident-platform backlog #0-269, ADR-0060 D5 as
# amended). Its one GitHub credential is the hour's token of the app `profitbuild-factory-dev`, minted on the host by
# dispatcher/bin/dev-token.mjs and read from /run/factory-token/token; the app's key never enters it, nor the owner's
# gh login, Keychain or SSH keys, nor the token of incident-platform's autopilot bot (lukaszplawiakbot). That holds when
# the devcontainer CLI starts it; VS Code's "Reopen in Container" forwards the host's git credential helper and SSH
# agent (devcontainer.json; credential-check.sh refuses such a container loudly).
# What it isolates: the host's files (nothing of the host is mounted but the token's directory, read-only: the
# workspace is a volume of its own, so the host never runs a file the container wrote, a git hook included); outbound
# network (init-firewall.sh: default deny, GitHub and Anthropic only). No Docker socket: the factory needs none.
# Arch: builds natively on arm64 (Apple silicon) and amd64.
# ============================================================
# The Node of .node-version, by the digest of its multi-arch index: a tag can be moved, a digest cannot.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

RUN apt-get update && apt-get install -y --no-install-recommends \
        git jq curl ca-certificates gnupg sudo less \
        iptables ipset iproute2 dnsutils \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's apt repository (signed), at /usr/bin/gh; /usr/local/bin/gh, first on PATH, wraps it.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# The image's user `node` (uid 1000) is the one that works here; sudo only for the firewall script, and only without
# arguments: `""` is sudoers' "no arguments" (incident-platform backlog #0-311, as its #0-283 did for its own image).
# The script refuses any argument too, and takes no list (run again, it cuts the network until a restart:
# init-firewall.sh); the rule no longer leans on that alone. The base image's `node` is in no group but its own; it
# leaves `sudo`, and `admin`, the other group /etc/sudoers grants every command to, should a new base image put it in
# one: with a password set later, or a NOPASSWD rule for the group, it would have every command.
RUN for g in sudo admin; do if id -nG node | tr ' ' '\n' | grep -qx "$g"; then gpasswd -d node "$g"; fi; done \
    && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh \"\"" > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && visudo -cf /etc/sudoers.d/node

# Claude Code at claude-code.pin's version, from the manifest Anthropic signed, root's and read-only to `node` in
# /usr/local/bin (incident-platform backlog #0-311, ADR-0065; its #0-249 and #0-283 for its own image). It was
# `curl -fsSL https://claude.ai/install.sh | bash` as `node`: whatever version was newest the day the image was built,
# into `node`'s ~/.local, where code a session ran could replace the binary. claude-code.pin, install-claude-code.sh
# and keys/ are incident-platform's files, byte for byte (its check-factory-copies.rb compares them, ADR-0061). The
# build fetches from downloads.claude.ai, with no firewall yet; the running container never does. Before the scripts'
# layer below, so a change there does not download the binary again.
COPY claude-code.pin install-claude-code.sh /usr/local/share/claude-code/
COPY keys/ /usr/local/share/claude-code/keys/
RUN /usr/local/share/claude-code/install-claude-code.sh --pin /usr/local/share/claude-code/claude-code.pin \
        --keys /usr/local/share/claude-code/keys --into /usr/local/bin

COPY init-firewall.sh credential-check.sh gh-app-token.sh git-credential-app-token.sh factory-workspace.sh /usr/local/bin/
RUN mv /usr/local/bin/gh-app-token.sh /usr/local/bin/gh \
    && mv /usr/local/bin/git-credential-app-token.sh /usr/local/bin/git-credential-app-token \
    && chmod 0755 /usr/local/bin/init-firewall.sh /usr/local/bin/credential-check.sh /usr/local/bin/gh \
        /usr/local/bin/git-credential-app-token /usr/local/bin/factory-workspace.sh

# git asks the app's token of the helper, never of a URL or an argument. The empty entry clears any helper configured
# before it; the system config, as a rebuild keeps it.
RUN git config --system --add credential.https://github.com.helper '' \
    && git config --system --add credential.https://github.com.helper '/usr/local/bin/git-credential-app-token'

# The mount points of the named volumes, created as `node`: Docker gives a new volume the owner of the directory it is
# mounted over, and one the image does not have is root's.
RUN mkdir -p /workspace /home/node/.claude && chown node:node /workspace /home/node/.claude

USER node
WORKDIR /home/node

# Claude Code updates nothing in the container: DISABLE_AUTOUPDATER stops the background check only, and
# `claude update` or `claude install` would still lay a newer version out under ~/.local; DISABLE_UPDATES blocks every
# path (Claude Code's setup documentation). ~/.local/bin is not put on PATH: the installed binary is
# /usr/local/bin/claude (above), and a `claude` a session left in ~/.local/bin must not shadow it. A bump is a change
# to claude-code.pin, made in incident-platform and copied here, then a rebuild.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1
