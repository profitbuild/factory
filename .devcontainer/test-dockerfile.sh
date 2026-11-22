#!/usr/bin/env bash
# ============================================================
# The devcontainer's Dockerfile, read as text (incident-platform backlog #0-311): CI builds no image, so what the
# image must hold is checked here, without Docker.
#
#   test-dockerfile.sh               checks .devcontainer/Dockerfile, then its own mutations (CI: Lint Workflows)
#   test-dockerfile.sh <Dockerfile>  checks that file alone
#
# The rules:
#   R1  no `install.sh` piped to a shell (Claude Code's unpinned installer, which installs into the user's ~/.local);
#   R2  no ~/.local/bin outside a comment (a `claude` there would shadow /usr/local/bin/claude);
#   R3  claude-code.pin, install-claude-code.sh and keys/ copied to /usr/local/share/claude-code/, and one
#       `RUN …/install-claude-code.sh --pin … --keys … --into /usr/local/bin` after them and before the first USER,
#       which is `node`: the binary is root's, not the user's;
#   R4  DISABLE_AUTOUPDATER=1 and DISABLE_UPDATES=1 in an ENV;
#   R5  one sudoers rule, /etc/sudoers.d/node, exactly `node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh ""`
#       (`""` is sudoers' "no arguments"), in the same RUN as `chmod 0440` and `visudo -cf` of that file, and `node`
#       taken out of `sudo` and `admin`; the rule passes visudo here too, when visudo is installed;
#   R6  install-claude-code.sh is executable (COPY keeps the mode, and the RUN runs it).
# Each mutation below breaks one rule on a copy of the Dockerfile, which must then fail: a rule that cannot fail is
# no rule. What a built image holds is the owner's check after a rebuild (README, "Development").
# ============================================================
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)

# instructions <Dockerfile> — one line per instruction: comments and blank lines dropped, continuations joined.
instructions() {
    awk '
        /^[[:space:]]*#/ { next }
        { line = cur $0; if (sub(/\\[[:space:]]*$/, "", line)) { cur = line " "; next } cur = "" }
        line ~ /[^[:space:]]/ { print line }
    ' "$1"
}

# check <Dockerfile> <directory of its sources> — every rule; prints each failure, fails if any did.
check() {
    local file=$1 src=$2 ins fails=0 n first_user install copy_pin copy_keys sudo_line rule
    ins=$(instructions "$file")
    fail() { echo "  $1" >&2; fails=$((fails + 1)); }
    # The first instruction whose line matches the ERE, by number among the instructions; 0 when none.
    at() { grep -nE -- "$1" <<<"$ins" | head -1 | cut -d: -f1 || true; }
    count() { grep -cE -- "$1" <<<"$ins" || true; }

    # R1
    if grep -Eq 'install\.sh[^|]*\|[[:space:]]*(ba|z|da)?sh\b' <<<"$ins"; then fail "R1: install.sh is piped to a shell"; fi
    # R2
    if grep -q '\.local/bin' <<<"$ins"; then fail "R2: ~/.local/bin outside a comment"; fi
    # R3
    first_user=$(at '^USER[[:space:]]')
    [ -n "$first_user" ] || fail "R3: no USER"
    if [ -n "$first_user" ] && ! sed -n "${first_user}p" <<<"$ins" | grep -Eq '^USER[[:space:]]+node[[:space:]]*$'; then
        fail "R3: the first USER is not node"
    fi
    copy_pin=$(at '^COPY[[:space:]]+claude-code\.pin[[:space:]]+install-claude-code\.sh[[:space:]]+/usr/local/share/claude-code/[[:space:]]*$')
    copy_keys=$(at '^COPY[[:space:]]+keys/[[:space:]]+/usr/local/share/claude-code/keys/[[:space:]]*$')
    n=$(count 'install-claude-code\.sh[[:space:]]+--')
    install=$(at '^RUN[[:space:]]+/usr/local/share/claude-code/install-claude-code\.sh[[:space:]]+--pin[[:space:]]+/usr/local/share/claude-code/claude-code\.pin[[:space:]]+--keys[[:space:]]+/usr/local/share/claude-code/keys[[:space:]]+--into[[:space:]]+/usr/local/bin[[:space:]]*$')
    [ "$n" = 1 ] || fail "R3: install-claude-code.sh is run $n times, not once"
    [ -n "$copy_pin" ] || fail "R3: no COPY of claude-code.pin and install-claude-code.sh to /usr/local/share/claude-code/"
    [ -n "$copy_keys" ] || fail "R3: no COPY of keys/ to /usr/local/share/claude-code/keys/"
    if [ -z "$install" ]; then
        fail "R3: no RUN of install-claude-code.sh --pin … --keys … --into /usr/local/bin"
    else
        if [ -n "$first_user" ] && [ "$install" -gt "$first_user" ]; then fail "R3: Claude Code is installed after USER, not as root"; fi
        if [ -n "$copy_pin" ] && [ "$copy_pin" -gt "$install" ]; then fail "R3: the pin is copied after the install"; fi
        if [ -n "$copy_keys" ] && [ "$copy_keys" -gt "$install" ]; then fail "R3: the keys are copied after the install"; fi
    fi
    # R4
    for v in DISABLE_AUTOUPDATER DISABLE_UPDATES; do
        grep -Eq "^ENV[[:space:]](.*[[:space:]])?$v=1([[:space:]]|$)" <<<"$ins" || fail "R4: no ENV $v=1"
    done
    # R5
    n=$(count 'sudoers|NOPASSWD')
    [ "$n" = 1 ] || fail "R5: $n instructions name sudoers or NOPASSWD, not one"
    sudo_line=$(grep -E 'sudoers|NOPASSWD' <<<"$ins" | head -1 || true)
    rule='node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh ""'
    # The echo's argument as the shell reads it: `\"` is `"`.
    if ! grep -qF -- "echo \"${rule//\"/\\\"}\" > /etc/sudoers.d/node " <<<"$sudo_line"; then
        fail "R5: the rule is not exactly: $rule"
    fi
    grep -Eq -- '&& chmod 0440 /etc/sudoers.d/node( |$)' <<<"$sudo_line" || fail "R5: no chmod 0440 of /etc/sudoers.d/node in the rule's RUN"
    grep -Eq -- '&& visudo -cf /etc/sudoers.d/node[[:space:]]*$' <<<"$sudo_line" || fail "R5: no visudo -cf of /etc/sudoers.d/node, last in the rule's RUN"
    # shellcheck disable=SC2016 # the Dockerfile's text, `$g` and all, not this shell's variable
    if ! grep -qF -- 'for g in sudo admin; do if id -nG node ' <<<"$sudo_line" \
        || ! grep -qF -- 'gpasswd -d node "$g"' <<<"$sudo_line"; then
        fail "R5: node is not taken out of sudo and admin in the rule's RUN"
    fi
    if command -v visudo >/dev/null 2>&1 || [ -x /usr/sbin/visudo ]; then
        local tmp
        tmp=$(mktemp)
        printf '%s\n' "$rule" >"$tmp"
        "$(command -v visudo || echo /usr/sbin/visudo)" -cf "$tmp" >/dev/null || fail "R5: visudo refuses the rule"
        rm -f "$tmp"
    fi
    # R6
    [ -x "$src/install-claude-code.sh" ] || fail "R6: install-claude-code.sh is not executable"

    [ "$fails" = 0 ]
}

if [ $# -gt 1 ]; then echo "usage: $0 [Dockerfile]" >&2; exit 2; fi
if [ $# = 1 ]; then
    check "$1" "$(cd "$(dirname "$1")" && pwd)" || { echo "$1: FAILED" >&2; exit 1; }
    echo "$1: every rule holds."
    exit 0
fi

check "$here/Dockerfile" "$here" || { echo ".devcontainer/Dockerfile: FAILED" >&2; exit 1; }
echo ".devcontainer/Dockerfile: every rule holds."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/src"
cp "$here/install-claude-code.sh" "$work/src/"

# <name>|<sed script>: each one rule's mutation, applied to a copy, which must change and then fail.
# shellcheck disable=SC2016 # sed scripts that write Dockerfile text, `${PATH}` among it, not this shell's variables
mutations=(
    'R1 install.sh piped to bash|s#^ENV DISABLE_AUTOUPDATER=1#RUN curl -fsSL https://claude.ai/install.sh | bash\nENV DISABLE_AUTOUPDATER=1#'
    'R2 ~/.local/bin on PATH|s#^    DISABLE_UPDATES=1#    DISABLE_UPDATES=1 \\\n    PATH="/home/node/.local/bin:${PATH}"#'
    'R3 the install after USER node|/^RUN \/usr\/local\/share\/claude-code\/install-claude-code.sh/{N;d;};s#^WORKDIR /home/node#WORKDIR /home/node\nRUN /usr/local/share/claude-code/install-claude-code.sh --pin /usr/local/share/claude-code/claude-code.pin --keys /usr/local/share/claude-code/keys --into /usr/local/bin#'
    'R3 the install into ~/bin|s#--into /usr/local/bin$#--into /home/node/bin#'
    'R3 the install run twice|s#^USER node#RUN /usr/local/share/claude-code/install-claude-code.sh --check --pin x --keys y\nUSER node#'
    'R3 no COPY of the keys|/^COPY keys\//d'
    'R3 the pin copied after the install|/^COPY claude-code.pin /d;s#^USER node#COPY claude-code.pin install-claude-code.sh /usr/local/share/claude-code/\nUSER node#'
    'R3 the first USER is root|s#^USER node#USER root\nUSER node#'
    'R4 no DISABLE_UPDATES|s#^ENV DISABLE_AUTOUPDATER=1 \\#ENV DISABLE_AUTOUPDATER=1#;/^    DISABLE_UPDATES=1/d'
    'R4 no DISABLE_AUTOUPDATER|s#^ENV DISABLE_AUTOUPDATER=1 \\#ENV \\#'
    'R4 DISABLE_UPDATES=0|s#DISABLE_UPDATES=1#DISABLE_UPDATES=0#'
    'R5 the rule takes any argument|s#init-firewall.sh \\"\\"" > /etc/sudoers.d/node#init-firewall.sh" > /etc/sudoers.d/node#'
    'R5 the rule allows every command|s#NOPASSWD: /usr/local/bin/init-firewall.sh#NOPASSWD: ALL, /usr/local/bin/init-firewall.sh#'
    'R5 a second rule|s#^USER node#RUN echo "node ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers.d/node\nUSER node#'
    'R5 no chmod 0440|s#chmod 0440 /etc/sudoers.d/node#chmod 0640 /etc/sudoers.d/node#'
    'R5 no visudo|/    \&\& visudo -cf \/etc\/sudoers.d\/node/d;s#\(chmod 0440 /etc/sudoers.d/node\) \\$#\1#'
    'R5 node kept in sudo|s#for g in sudo admin; do#for g in admin; do#'
)
failed=0
# expect_caught <name> <Dockerfile> <sources> — the check must fail, and only on the rule the name begins with: a
# mutation caught by another rule proves nothing of its own.
expect_caught() {
    local name=$1 rule=${1%% *}
    if check "$2" "$3" 2>"$work/out"; then
        echo "mutation '$name' passed: the rule does not hold it" >&2; failed=1
    elif grep -qv "^  $rule: " "$work/out"; then
        echo "mutation '$name' failed on another rule than $rule:" >&2; cat "$work/out" >&2; failed=1
    else
        echo "mutation '$name' fails, as it must: $(head -1 "$work/out" | sed 's/^  //')"
    fi
}
for m in "${mutations[@]}"; do
    name=${m%%|*} script=${m#*|}
    sed -e "$script" "$here/Dockerfile" >"$work/Dockerfile"
    if cmp -s "$here/Dockerfile" "$work/Dockerfile"; then
        echo "mutation '$name' changed nothing: fix the mutation" >&2; failed=1; continue
    fi
    expect_caught "$name" "$work/Dockerfile" "$work/src"
done
# R6, on the file's mode rather than the Dockerfile's text.
chmod 0644 "$work/src/install-claude-code.sh"
expect_caught 'R6 install-claude-code.sh not executable' "$here/Dockerfile" "$work/src"
[ "$failed" = 0 ] || { echo "test-dockerfile.sh: a mutation was not caught" >&2; exit 1; }
echo "Every mutation fails."
