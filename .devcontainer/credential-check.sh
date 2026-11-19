#!/usr/bin/env bash
# Refuses, loudly, a container into which its client forwarded the host's credentials (incident-platform backlog
# #0-269, review round 1): VS Code's Dev Containers extension, on "Reopen in Container", adds a git credential helper
# to ~/.gitconfig that asks the host's (the owner's admin token, from the Keychain) over an IPC socket, and forwards
# the host's SSH agent. The devcontainer CLI forwards neither. devcontainer.json blanks SSH_AUTH_SOCK, so a forwarded
# agent is looked for by its socket in /tmp as well as by the variable (review round 2). Run at every start and every attach
# (devcontainer.json); a client that forwards after this ran is not seen, so this is a tripwire, not a boundary:
# the boundary is starting the container with the devcontainer CLI (README "Development").
set -euo pipefail
found=()
if helpers=$(git config --global --get-all credential.helper 2>/dev/null) && [ -n "$helpers" ]; then
    found+=("a git credential helper in ~/.gitconfig: $helpers")
fi
# VS Code's sockets: its SSH agent, its git credential helper and its IPC; any SSH agent's (`ssh-*/agent.*`).
while IFS= read -r socket; do
    found+=("a forwarded socket: $socket")
done < <(find /tmp -maxdepth 2 -type s \( -name 'vscode-ssh-auth-*' -o -name 'vscode-git-*' \
    -o -name 'vscode-remote-containers-ipc-*' -o -path '/tmp/ssh-*/agent.*' \) 2>/dev/null)
for var in SSH_AUTH_SOCK REMOTE_CONTAINERS_IPC VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_MAIN GIT_ASKPASS; do
    if [ -n "${!var:-}" ]; then
        found+=("$var is set")
    fi
done
if [ "${#found[@]}" -ne 0 ]; then
    {
        echo "credential-check: this container holds credentials forwarded from the host:"
        printf '  - %s\n' "${found[@]}"
        echo "Start it with the devcontainer CLI instead (README \"Development\"); do not run a session here."
    } >&2
    exit 1
fi
echo "credential-check: no forwarded credential found."
