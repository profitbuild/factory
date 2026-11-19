#!/usr/bin/env bash
# Installed as /usr/local/bin/gh, ahead of GitHub's own /usr/bin/gh on PATH (incident-platform backlog #0-269): gives
# gh the app's token through GH_TOKEN, in the environment of this one gh process only, read from the file the host's
# dispatcher/bin/dev-token.mjs keeps fresh. There is no gh login in this container to fall back on.
set -euo pipefail
token_file=/run/factory-token/token
if [ ! -s "$token_file" ]; then
    echo "gh: no app token in $token_file: on the host, run node dispatcher/bin/dev-token.mjs --watch" >&2
    exit 1
fi
GH_TOKEN=$(<"$token_file")
export GH_TOKEN
exec /usr/bin/gh "$@"
