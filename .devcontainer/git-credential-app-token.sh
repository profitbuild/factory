#!/usr/bin/env bash
# git's credential helper for https://github.com in this container (incident-platform backlog #0-269): answers `get`
# with the app's token, read from the file the host's dispatcher/bin/dev-token.mjs keeps fresh; `store` and `erase`
# do nothing, since the token is the host's to replace. git reads the answer from stdout, so the token never sits in a
# URL, an argument or the environment. With no token it answers `quit=1`, so git asks no helper after it: a helper a
# client added to ~/.gitconfig (VS Code's, which asks the host's, the owner's admin token) would come next otherwise
# (review round 2).
set -euo pipefail
token_file=/run/factory-token/token
# git sends the request's attributes on stdin; none of them changes the answer.
cat >/dev/null
[ "${1:-}" = get ] || exit 0
if [ ! -s "$token_file" ]; then
    echo "git-credential-app-token: no app token in $token_file: on the host, run node dispatcher/bin/dev-token.mjs --watch" >&2
    printf 'quit=1\n'
    exit 0
fi
printf 'username=x-access-token\npassword=%s\n' "$(<"$token_file")"
