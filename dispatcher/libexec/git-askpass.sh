#!/bin/sh
# GIT_ASKPASS of builder-app's push (incident-platform backlog #0-271): git runs it to ask for a credential, the
# question in $1, and reads the answer from stdout. It answers only for the origin the dispatcher pushes to
# (FACTORY_PUSH_ORIGIN): the user x-access-token, and the token from FACTORY_PUSH_TOKEN, a variable of the git
# process's own environment (src/github/builder-token.mjs, gitPushCommand). A question for any other origin, as a URL
# rewritten by `url.<base>.insteadOf` to another https:// host would ask, gets nothing and fails the push. A URL
# rewritten to another protocol (ssh://, whose core.sshCommand would see the token in its environment) never gets
# here: GIT_ALLOW_PROTOCOL, set by gitPushCommand, makes git refuse it. Both are a second layer: the push runs only in
# a repository the dispatcher made for it, whose config is held to a reference `git init --bare`'s before the token is
# asked for (src/github/push.mjs, incident-platform backlog #0-276), so no http.proxy, http.<url>.sslVerify,
# http.sslCAInfo, http.curloptResolve or include.path can send the token elsewhere. printf is the shell's builtin, so
# the token is in no argument of any process; it is in no URL and no file.
#
# Why the devcontainer keeps a credential helper that reads a file (.devcontainer/git-credential-app-token.sh): there
# the token is minted on the host (dispatcher/bin/dev-token.mjs) and used by a git inside a container, which is no
# child of the process that minted it; a container's environment is fixed when it starts, and the token changes every
# hour, so a mounted file is what crosses from the host into the container. Here git is the dispatcher's own child:
# the token goes in the environment of that one process and never touches the disk.
set -eu
origin=${FACTORY_PUSH_ORIGIN:?git-askpass: FACTORY_PUSH_ORIGIN is not set}
scheme=${origin%%://*}
host=${origin#*://}
case "${1:-}" in
"Username for '$origin': ")
    printf 'x-access-token\n'
    ;;
"Password for '$scheme://x-access-token@$host': ")
    printf '%s\n' "${FACTORY_PUSH_TOKEN:?git-askpass: FACTORY_PUSH_TOKEN is not set}"
    ;;
*)
    echo "git-askpass: no credential for this question (only $origin is answered): ${1:-}" >&2
    exit 1
    ;;
esac
