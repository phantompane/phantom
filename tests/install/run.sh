#!/bin/sh
# Portable offline integration tests. Fixtures are generated, never downloaded.
# Select awk via PATH, e.g. PATH=/tmp/awkshim/ow:$PATH sh tests/install/run.sh.
# BusyBox wrappers may use `exec busybox awk "$@"`; isolated tests retain busybox.
set -eu

suiteDir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
installer=$suiteDir/../../install.sh
root=$(mktemp -d "${TMPDIR:-/tmp}/mabo-installer-test.XXXXXXXX")
trap 'rm -rf "$root"' 0
trap 'exit 1' HUP INT TERM
originalPath=$PATH
# Each invocation uses the same shell as this suite, including bash --posix.
if [ -n "${BASH_VERSION-}" ]; then runner=bash; else runner='sh'; fi
case $(ps -p $$ -o comm=) in *dash*) runner=dash ;; sh|*/sh) runner='sh' ;; esac

fail() { printf 'FAIL: %s\n' "$*" >&2; cat "$root/stderr" >&2; exit 1; }
contains() { grep -F -e "$2" "$1" >/dev/null || fail "Expected $2 in $1"; }
notContains() { if grep -F -e "$2" "$1" >/dev/null; then fail "Unexpected $2 in $1"; fi; }

mkdir -p "$root/releases" "$root/api" "$root/home" "$root/tmp" "$root/bin"
export HOME="$root/home" TMPDIR="$root/tmp"
export MABO_RELEASE_BASE_URL="file://$root/releases" MABO_API_URL="file://$root/api"
unset MABO_VERSION MABO_INSTALL_DIR MABO_PRERELEASE MABO_VERIFY_ATTESTATION MABO_ATTESTATION_TIMEOUT GITHUB_TOKEN
cat > "$root/bin/uname" <<'SH'
#!/bin/sh
case $1 in -s) printf '%s\n' "${TEST_OS:-Linux}" ;; -m) printf '%s\n' "${TEST_ARCH:-x86_64}" ;; esac
SH
chmod +x "$root/bin/uname"
export PATH="$root/bin:$originalPath"

hashFile() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
    else shasum -a 256 "$1"; fi
}
makeRelease() {
    release=$1
    reported=${2:-$1}
    member=${3:-mabo}
    fixture=$root/releases/v$release
    mkdir -p "$fixture" "$root/build"
    rm -f "$root/build/mabo" "$root/build/other"
    printf '#!/bin/sh\nprintf "mabo v%s+rust (test)\\n"\n' "$reported" > "$root/build/$member"
    chmod +x "$root/build/$member"
    for platform in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
        asset=maboroshi-v$release-$platform.tar.gz
        tar -czf "$fixture/$asset" -C "$root/build" "$member"
        digest=$(hashFile "$fixture/$asset"); digest=${digest%% *}
        printf '%s  %s\n' "$digest" "$asset"
    done > "$fixture/SHA256SUMS"
}
makeRelease 7.0.0
makeRelease 7.1.0
makeRelease 7.2.0-alpha.1
makeRelease 7.3.0-draft
makeRelease 7.4.0-wrong 7.4.0-wronger
makeRelease 7.5.0-missing 7.5.0-missing other
makeRelease 7.6.0-checksum
makeRelease 7.7.0-nosums
makeRelease 7.8.0-noline
printf 'corruption\n' >> "$root/releases/v7.6.0-checksum/maboroshi-v7.6.0-checksum-linux-x64.tar.gz"
rm "$root/releases/v7.7.0-nosums/SHA256SUMS"
printf '%064d  maboroshi-v7.8.0-noline-linux-x64.tar.gz.extra\n' 0 > "$root/releases/v7.8.0-noline/SHA256SUMS"

# Asset names precede tags; unrelated nested fields and escaped string contents
# must never masquerade as release metadata. Both JSON layouts have the same data.
writeApi() {
    layout=$1
    stable=$2
    {
        printf '[\n'
        printf '{"tag_name":"v6.3.2","draft":false,"prerelease":false,"assets":[{"name":"phantom-v6.3.2-linux-x64.tar.gz"}]},\n'
        printf '{"tag_name":"v7.3.0-draft","draft":true,"prerelease":false,"assets":[{"name":"maboroshi-v7.3.0-draft-linux-x64.tar.gz"}]},\n'
        printf '{"tag_name":"v7.9.0-no-platform","draft":false,"prerelease":false,"assets":[{"name":"maboroshi-v7.9.0-no-platform-darwin-arm64.tar.gz"}]},\n'
        printf '{"body":"braces } [, tag_name: \\"trick\\"", "assets":[{"name":"maboroshi-v7.2.0-alpha.1-linux-x64.tar.gz"}],"prerelease":true,"draft":false,"tag_name":"v7.2.0-alpha.1"}'
        if [ "$stable" = yes ]; then
            printf ',\n{"assets":[{"uploader":{"name":"ignored"},"name":"maboroshi-v7.1.0-linux-x64.tar.gz"}],"author":{"draft":true,"tag_name":"wrong"},"draft":false,"prerelease":false,"tag_name":"v7.1.0"},\n'
            printf '{"tag_name":"v7.0.0","draft":false,"prerelease":false,"assets":[{"name":"maboroshi-v7.0.0-linux-x64.tar.gz"}]}'
        fi
        printf '\n]\n'
    } > "$root/api/source"
    if [ "$layout" = compact ]; then
        tr -d '\n' < "$root/api/source" > "$root/api/releases?per_page=100"
    else
        # Insert whitespace outside strings with a tiny lexer, not sed on values.
        awk '{ for(i=1;i<=length($0);i++) { c=substr($0,i,1); printf "%s",c
            if(!escaped && c=="\"") quoted=!quoted
            if(!quoted && (c=="," || c==":" || c=="{" || c=="}" || c=="[" || c=="]")) printf "\n  "
            if(c=="\\" && !escaped) escaped=1; else escaped=0
        } print "" }' "$root/api/source" > "$root/api/releases?per_page=100"
    fi
}

count=0
run() {
    wanted=$1; shift
    status=0
    if [ "$runner" = bash ]; then
        bash --posix "$installer" "$@" > "$root/stdout" 2> "$root/stderr" </dev/null || status=$?
    else
        "$runner" "$installer" "$@" > "$root/stdout" 2> "$root/stderr" </dev/null || status=$?
    fi
    [ "$status" = "$wanted" ] || fail "Exit $status, expected $wanted: $*"
    # All runs must remove download and install staging directories.
    [ -z "$(ls -A "$root/tmp")" ] || fail 'Leaked download directory'
    [ -z "$(find "$root" -name '.mabo.install.*' -print)" ] || fail 'Leaked staging directory'
    notContains "$root/stdout" 'test-secret-token'
    notContains "$root/stderr" 'test-secret-token'
    count=$((count+1))
}
runFail() {
    expectedStatus=$1 expectedMessage=$2
    shift 2
    run "$expectedStatus" "$@"
    contains "$root/stderr" "$expectedMessage"
}
assertVersion() {
    contains "$root/stdout" "Installed mabo v$1 to $2/mabo"
    [ "$("$2/mabo" --version)" = "mabo v$1+rust (test)" ] || fail 'Wrong installed version'
    [ -x "$2/mabo" ] || fail 'Installed binary is not executable'
}
unchanged() {
    cmp "$root/before" "$HOME/.local/bin/mabo" || fail 'Existing binary changed on failure'
}

# Flags override env; pins bypass the API entirely. stdin is always /dev/null.
export MABO_API_URL="file://$root/nonexistent" GITHUB_TOKEN=test-secret-token
run 0 --version v7.0.0
assertVersion 7.0.0 "$HOME/.local/bin"
contains "$root/stderr" 'export PATH='
cp "$HOME/.local/bin/mabo" "$root/before"
# A hard link keeps the previous inode observable: successful reinstallation must
# replace the file, not merely decide the version is already installed.
ln "$HOME/.local/bin/mabo" "$root/old-inode"
run 0 --version 7.0.0
assertVersion 7.0.0 "$HOME/.local/bin"
printf 'old inode\n' > "$root/old-inode"
unchanged
export MABO_VERSION=v7.0.0 MABO_INSTALL_DIR="$HOME/ignored"
run 0 --version 7.1.0 --install-dir "$HOME/.local/bin"
assertVersion 7.1.0 "$HOME/.local/bin"
[ ! -e "$HOME/ignored" ] || fail 'Flags did not override env'
unset MABO_VERSION MABO_INSTALL_DIR
export MABO_VERSION=7.0.0
run 0
assertVersion 7.0.0 "$HOME/.local/bin"
unset MABO_VERSION

export MABO_API_URL="file://$root/api"
for layout in compact pretty; do
    writeApi "$layout" yes
    run 0
    assertVersion 7.1.0 "$HOME/.local/bin"
    run 0 --prerelease
    assertVersion 7.2.0-alpha.1 "$HOME/.local/bin"
    writeApi "$layout" no
    runFail 1 'No stable mabo release; newest prerelease is v7.2.0-alpha.1'
    contains "$root/stderr" 'MABO_VERSION=v7.2.0-alpha.1'
    contains "$root/stderr" '--prerelease'
    export MABO_PRERELEASE=1
    run 0
    assertVersion 7.2.0-alpha.1 "$HOME/.local/bin"
    unset MABO_PRERELEASE
done

# About 1.6 MB across 100 releases, with long escaped bodies. Generate both JSON
# layouts without walking a giant string in awk (the regression we are testing).
# Even a selected first release must not bypass validation of the remaining data.
for layout in compact pretty; do
    awk -v layout="$layout" 'BEGIN {
        sep=(layout=="pretty" ? "\n  " : "")
        printf "[%s",sep
        for(i=1;i<=100;i++) {
            tag=(i==1 ? "7.2.0-alpha.1" : (i==2 ? "7.1.0" : "7.3.0-draft"))
            printf "{\"tag_name\":\"v%s\",%s\"draft\":%s,%s\"prerelease\":%s,%s",tag,sep,(i>2 ? "true" : "false"),sep,(i==1 ? "true" : "false"),sep
            printf "\"assets\":[{\"name\":\"maboroshi-v%s-linux-x64.tar.gz\"}],%s\"body\":\"",tag,sep
            for(j=0;j<150;j++) printf "Release notes: { [ ] } , : \\\"tag_name\\\": \\\"trick\\\", backslash \\\\, newline \\n, Unicode \\u65e5. More details. "
            printf "\"}%s%s",(i<100 ? "," : ""),sep
        }
        print "]"
    }' > "$root/api/releases?per_page=100"
    bytes=$(wc -c < "$root/api/releases?per_page=100")
    if [ "$bytes" -lt 1000000 ] || [ "$bytes" -gt 2000000 ]; then
        fail "Unexpected large fixture size: $bytes"
    fi
    run 0
    assertVersion 7.1.0 "$HOME/.local/bin"
    run 0 --prerelease
    assertVersion 7.2.0-alpha.1 "$HOME/.local/bin"
    printf 'garbage' >> "$root/api/releases?per_page=100"
    runFail 1 'Invalid GitHub API response'
done

# Unicode-escaped ASCII keys/values are equivalent; punctuation and escaped
# backslashes in unrelated keys must not manufacture direct assets[].name fields.
cat > "$root/api/releases?per_page=100" <<'JSON'
[{"tag_name":"v7.3.0-draft","draft":false,"prerelease":false,
  "assets/item/name":"maboroshi-v7.3.0-draft-linux-x64.tar.gz",
  "assets":[[{"name":"maboroshi-v7.3.0-draft-linux-x64.tar.gz"}],
            {"nested":{"name":"maboroshi-v7.3.0-draft-linux-x64.tar.gz"}}]},
 {"t\u0061g_name":"\u00767.1.0","draft":false,"prerelease":false,
  "escaped\\u0061\"\/\b\f\n\r\t\u0026\u005c\u00AF":null,
  "assets":[{"n\u0061me":"maboroshi-v7.1.0-linux-x64.tar.g\u007a"}]}]
JSON
run 0
assertVersion 7.1.0 "$HOME/.local/bin"
printf '[]\n' > "$root/api/releases?per_page=100"
runFail 1 'No matching mabo release. Pin MABO_VERSION or use --prerelease.'

cp "$HOME/.local/bin/mabo" "$root/before"
for broken in 7.6.0-checksum 7.7.0-nosums 7.8.0-noline 7.5.0-missing 7.4.0-wrong; do
    case $broken in
        *checksum) reason='Checksum mismatch' ;;
        *nosums) reason='Missing or unavailable SHA256SUMS' ;;
        *noline) reason='Missing, duplicate, or invalid SHA256SUMS line' ;;
        *missing) reason='Archive is missing a regular mabo executable' ;;
        *wrong) reason='Downloaded mabo version does not match' ;;
    esac
    runFail 1 "$reason" --version "$broken"
    unchanged
done

mkdir -p "$HOME/managed"
printf 'package manager binary\n' > "$root/managed-target"
ln -s "$root/managed-target" "$HOME/managed/mabo"
runFail 1 'managed elsewhere' --version 7.0.0 --install-dir "$HOME/managed"
[ "$(cat "$root/managed-target")" = 'package manager binary' ] || fail 'Modified symlink target'
[ -L "$HOME/managed/mabo" ] || fail 'Replaced symlink'
rm "$HOME/managed/mabo"
ln -s "$root/nonexistent" "$HOME/managed/mabo"
runFail 1 'managed elsewhere' --version 7.0.0 --install-dir "$HOME/managed"
rm "$HOME/managed/mabo"
mkdir "$HOME/managed/mabo"
runFail 1 'managed elsewhere' --version 7.0.0 --install-dir "$HOME/managed"

# A restricted PATH makes absence reproducible even on developer/CI machines
# with gh, jq, python, curl or multiple checksum implementations installed.
mkdir "$root/tools"
for tool in sh bash dash awk busybox cat chmod cp grep mkdir mktemp mv ps rm sed sleep tar uname gzip; do
    found=$(command -v "$tool" || :)
    if [ -n "$found" ]; then ln -s "$found" "$root/tools/$tool"; fi
done
curlPath=$(command -v curl)
ln -s "$curlPath" "$root/tools/curl"
shaPath=$(command -v sha256sum || command -v shasum)
shaName=${shaPath##*/}
ln -s "$shaPath" "$root/tools/$shaName"
# The suite still uses its ordinary PATH; a wrapper isolates just the installer.
cat > "$root/bin/isolated-shell" <<'SH'
#!/bin/sh
PATH=$TEST_TOOLS
export PATH
case $TEST_RUNNER in
    bash) exec bash --posix "$@" ;;
    *) exec "$TEST_RUNNER" "$@" ;;
esac
SH
chmod +x "$root/bin/isolated-shell"
export TEST_TOOLS="$root/tools" TEST_RUNNER="$runner"
savedRunner=$runner
runner=isolated-shell
runFail 1 'requires gh' --version 7.0.0 --verify-attestation
unchanged
cat > "$root/tools/gh" <<'SH'
#!/bin/sh
printf '%s\n' "$$" > "$TEST_GH_PID"
printf '%s\n' "$@" > "$TEST_GH_ARGS"
# Attempting to read must see EOF, even when the installer itself is piped.
if read -r ignored; then exit 99; fi
case ${TEST_GH_MODE-} in
    delay) "$TEST_SLEEP" 1 ;;
    stall) exec "$TEST_SLEEP" 60 ;;
    ignore-term) trap '' TERM; exec "$TEST_SLEEP" 60 ;;
esac
exit "${TEST_GH_STATUS:-0}"
SH
chmod +x "$root/tools/gh"
export TEST_GH_ARGS="$root/gh-args" TEST_GH_PID="$root/gh-pid" TEST_GH_STATUS=1
# Record every watchdog sleep and its parent (the killer subshell), including the
# grace period. exec preserves the sleep PID so cancellation must reap it.
TEST_SLEEP=$(command -v sleep)
export TEST_SLEEP TEST_SLEEP_PIDS="$root/sleep-pids"
rm "$root/tools/sleep"
cat > "$root/tools/sleep" <<'SH'
#!/bin/sh
ps -p $$ -o ppid= >> "$TEST_SLEEP_PIDS"
printf '%s\n' "$$" >> "$TEST_SLEEP_PIDS"
exec "$TEST_SLEEP" "$@"
SH
chmod +x "$root/tools/sleep"
noAttestationProcesses() {
    for pidFile in "$TEST_GH_PID" "$TEST_SLEEP_PIDS"; do
        [ -f "$pidFile" ] || continue
        while read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill -KILL "$pid" 2>/dev/null || :
                fail "Leaked attestation process $pid"
            fi
        done < "$pidFile"
    done
}
# Leave time for the watchdog's sleep to start before success/failure cancellation.
export TEST_GH_MODE=delay
runFail 1 'Attestation verification failed' --version 7.0.0 --verify-attestation
unchanged
noAttestationProcesses
export TEST_GH_STATUS=0 MABO_VERIFY_ATTESTATION=1
run 0 --version 7.0.0
assertVersion 7.0.0 "$HOME/.local/bin"
noAttestationProcesses
[ "$(sed -n '1p' "$root/gh-args")" = attestation ] || fail 'Wrong gh command'
[ "$(sed -n '2p' "$root/gh-args")" = verify ] || fail 'Wrong gh subcommand'
contains "$root/gh-args" '/maboroshi-v7.0.0-linux-x64.tar.gz'
[ "$(sed -n '4p' "$root/gh-args")" = --repo ] || fail 'Wrong gh repo flag'
[ "$(sed -n '5p' "$root/gh-args")" = phantompane/phantom ] || fail 'Wrong gh repo'
[ "$(wc -l < "$root/gh-args" | tr -d ' ')" = 5 ] || fail 'Unexpected gh arguments'
unset MABO_VERIFY_ATTESTATION
# Capture stdout in a pipe as well as piping the script source: an uncancelled
# sleep must neither consume source bytes nor hold the output pipe open for 120s.
started=$(date +%s)
status=0
# shellcheck disable=SC2002
captured=$(cat "$installer" | MABO_VERSION=7.0.0 MABO_VERIFY_ATTESTATION=1 "$runner" 2> "$root/stderr") || status=$?
[ "$status" = 0 ] || fail 'Piped attestation install failed'
elapsed=$(( $(date +%s) - started ))
[ "$elapsed" -lt 20 ] || fail "Piped attestation install took $elapsed seconds"
printf '%s\n' "$captured" > "$root/stdout"
assertVersion 7.0.0 "$HOME/.local/bin"
noAttestationProcesses
[ -z "$(ls -A "$root/tmp")" ] || fail 'Leaked download directory'
[ -z "$(find "$root" -name '.mabo.install.*' -print)" ] || fail 'Leaked staging directory'
count=$((count+1))
# Both a normal TERM exit and a process requiring KILL must be bounded. The
# generous 20-second ceiling is far below the fake's 60-second sleep, allowing
# slow CI hosts without asserting the exact deadline/grace duration.
cp "$HOME/.local/bin/mabo" "$root/before"
for TEST_GH_MODE in stall ignore-term; do
    export TEST_GH_MODE MABO_ATTESTATION_TIMEOUT=1
    : > "$TEST_SLEEP_PIDS"
    started=$(date +%s)
    runFail 1 'Attestation verification timed out after 1 seconds for maboroshi-v7.0.0-linux-x64.tar.gz.' \
        --version 7.0.0 --verify-attestation
    elapsed=$(( $(date +%s) - started ))
    [ "$elapsed" -lt 20 ] || fail "Attestation timeout took $elapsed seconds"
    unchanged
    noAttestationProcesses
done
unset TEST_GH_MODE MABO_ATTESTATION_TIMEOUT
for MABO_ATTESTATION_TIMEOUT in '' 0 00 -1 1.5 nope; do
    export MABO_ATTESTATION_TIMEOUT
    runFail 2 'MABO_ATTESTATION_TIMEOUT must be a positive integer in seconds.' \
        --version 7.0.0 --verify-attestation
    unchanged
done
unset MABO_ATTESTATION_TIMEOUT
rm "$root/tools/curl"
# Missing curl must fail without invoking wget, regardless of its implementation.
cp "$HOME/.local/bin/mabo" "$root/before"
cat > "$root/tools/wget" <<'SH'
#!/bin/sh
printf '%s\n' "$@" >> "$TEST_WGET_ARGS"
case $TEST_WGET_KIND in
    GNU) printf 'GNU Wget 1.21 (mock)\n' ;;
    BusyBox) printf 'BusyBox wget: unrecognized option --version\n' >&2; exit 1 ;;
esac
SH
chmod +x "$root/tools/wget"
export TEST_WGET_ARGS="$root/wget-args"
curlRequired='curl is required. Install it with your package manager (Alpine: apk add curl).'
for TEST_WGET_KIND in GNU BusyBox; do
    export TEST_WGET_KIND
    : > "$TEST_WGET_ARGS"
    runFail 1 "$curlRequired" --version 7.0.0
    [ ! -s "$TEST_WGET_ARGS" ] || fail 'Invoked wget without curl'
    unchanged
done
unset TEST_WGET_ARGS TEST_WGET_KIND
rm "$root/tools/wget"
runFail 1 "$curlRequired" --version 7.0.0
unchanged
ln -s "$curlPath" "$root/tools/curl"
rm "$root/tools/$shaName"
runFail 1 'sha256sum or shasum' --version 7.0.0
if command -v shasum >/dev/null 2>&1; then
    ln -s "$(command -v shasum)" "$root/tools/shasum"
    run 0 --version 7.0.0
    assertVersion 7.0.0 "$HOME/.local/bin"
fi
runner=$savedRunner

# Supported aliases, both OS mappings, and unsupported platform alternatives.
for pair in 'Linux amd64' 'Linux aarch64' 'Darwin arm64' 'Darwin x86_64'; do
    TEST_OS=${pair% *} TEST_ARCH=${pair#* }
    export TEST_OS TEST_ARCH
    run 0 --version 7.0.0
    assertVersion 7.0.0 "$HOME/.local/bin"
done
export TEST_OS=FreeBSD TEST_ARCH=x86_64
runFail 1 'Unsupported platform' --version 7.0.0
contains "$root/stderr" 'https://github.com/phantompane/phantom/releases'
contains "$root/stderr" 'cargo install --git https://github.com/phantompane/phantom --tag 7.0.0 --locked maboroshi'
export TEST_OS=Linux TEST_ARCH=riscv64
runFail 1 'Unsupported platform' --version 7.0.0
unset TEST_OS TEST_ARCH
runFail 2 'Unknown option' --unknown
runFail 2 '--version requires a value' --version
runFail 2 '--install-dir requires a value' --install-dir
run 0 --help
contains "$root/stdout" 'Usage:'
contains "$root/stdout" 'Requires curl (Alpine: apk add curl).'
notContains "$root/stdout" 'wget'
run 0 -h
export MABO_API_URL="file://$root/nonexistent"
runFail 1 'GitHub API request failed. Pin MABO_VERSION'
contains "$root/stderr" 'GITHUB_TOKEN'
export MABO_API_URL="file://$root/api"
printf '{"message":"rate limit"}\n' > "$root/api/releases?per_page=100"
runFail 1 'Invalid GitHub API response'

# Pipe the actual script: commands must not consume its unread source bytes.
status=0
# Keep a pipe so the shell reads source from stdin, as with curl | sh.
# shellcheck disable=SC2002
cat "$installer" | MABO_VERSION=7.0.0 "$runner" > "$root/stdout" 2> "$root/stderr" || status=$?
[ "$status" = 0 ] || fail 'Piped installer failed'
assertVersion 7.0.0 "$HOME/.local/bin"

# Check PATH hints, shadow warning, quoting, spaces and unchanged rc files.
printf 'existing rc\n' > "$HOME/.profile"
cp "$HOME/.profile" "$root/profile-before"
mkdir "$root/shadow"
printf '#!/bin/sh\nexit 0\n' > "$root/shadow/mabo"
chmod +x "$root/shadow/mabo"
export PATH="$root/shadow:$HOME/.local/bin:$PATH"
run 0 --version 7.0.0
contains "$root/stderr" 'shadows'
notContains "$root/stderr" 'export PATH='
run 0 --version 7.0.0 --install-dir "$root/space and 'quote"
contains "$root/stderr" 'export PATH='
# The printed export must be executable shell syntax for exactly this directory.
hint=$(sed -n 's/^Add to PATH: //p' "$root/stderr")
actualDir=$(sh -c "$hint; printf '%s' \"\${PATH%%:*}\"")
[ "$actualDir" = "$root/space and 'quote" ] || fail 'Invalid PATH hint quoting'
cmp "$HOME/.profile" "$root/profile-before" || fail 'Changed shell profile'
rm "$HOME/.profile"
rm -rf "$HOME/managed"
[ "$(find "$HOME" -type f | wc -l | tr -d ' ')" = 1 ] || fail 'Unexpected files in HOME'
[ -z "$(find "$HOME" -type f ! -path "$HOME/.local/bin/mabo" -print)" ] || fail 'Created files outside install dir'
# Exercise HTTPS without network access. The fake curl client checks
# the actual security flags and requires credentials only on the one API request.
mkdir "$root/http-tools"
cat > "$root/http-tools/curl" <<'SH'
#!/bin/sh
set -eu
auth=no
secure=no
redirectSafe=no
tls=no
config=no
silent=no
connectTimeout=no
speedLimit=no
speedTime=no
maxTime=no
[ "$1" = --disable ] || exit 90
while [ "$#" -gt 0 ]; do
    case $1 in
        --disable) config=yes; shift ;;
        -fsSL) silent=yes; shift ;;
        --proto) [ "$2" = '=https' ] || exit 91; secure=yes; shift 2 ;;
        --proto-redir) [ "$2" = '=https' ] || exit 91; redirectSafe=yes; shift 2 ;;
        --tlsv1.2) tls=yes; shift ;;
        --connect-timeout) [ "$2" = 30 ] || exit 97; connectTimeout=yes; shift 2 ;;
        --speed-limit) [ "$2" = 1 ] || exit 97; speedLimit=yes; shift 2 ;;
        --speed-time) [ "$2" = 60 ] || exit 97; speedTime=yes; shift 2 ;;
        --max-time) [ "$2" = 600 ] || exit 97; maxTime=yes; shift 2 ;;
        -H) [ "$2" = "Authorization: Bearer $GITHUB_TOKEN" ] || exit 92; auth=yes; shift 2 ;;
        -o) output=$2; shift 2 ;;
        https://*) url=$1; shift ;;
        *) exit 93 ;;
    esac
done
[ "$config:$secure:$silent" = yes:yes:yes ] || exit 94
[ "$redirectSafe:$tls" = yes:yes ] || exit 94
[ "$connectTimeout:$speedLimit:$speedTime:$maxTime" = yes:yes:yes:yes ] || exit 97
case $url in
    'https://mirror.invalid/api/releases?per_page=100')
        kind=api
        [ "$auth" = yes ] || exit 95
        source=$TEST_ROOT/api/releases?per_page=100 ;;
    https://mirror.invalid/download/*)
        kind=asset
        [ "$auth" = no ] || exit 95
        source=$TEST_ROOT/releases/${url#https://mirror.invalid/download/} ;;
    *) exit 96 ;;
esac
printf 'curl %s auth=%s\n' "$kind" "$auth" >> "$TEST_ROOT/http-log"
if [ "${TEST_HTTP_FAILURE:-0}" = 1 ]; then
    printf 'Failure containing %s\n' "$GITHUB_TOKEN" >&2
    exit 22
fi
cp "$source" "$output"
SH
chmod +x "$root/http-tools/curl"
export TEST_ROOT="$root"
writeApi compact yes
export MABO_RELEASE_BASE_URL=https://mirror.invalid/download MABO_API_URL=https://mirror.invalid/api
cp "$HOME/.local/bin/mabo" "$root/before"
rm -f "$root/tools/curl"
ln -s "$root/http-tools/curl" "$root/tools/curl"
runner=isolated-shell
: > "$root/http-log"
run 0
assertVersion 7.1.0 "$HOME/.local/bin"
[ "$(cat "$root/http-log")" = "curl api auth=yes
curl asset auth=no
curl asset auth=no" ] || fail 'Incorrect HTTP requests or credential scope'
: > "$root/http-log"
run 0 --version 7.0.0
[ "$(cat "$root/http-log")" = "curl asset auth=no
curl asset auth=no" ] || fail 'Pinned install called API'
cp "$HOME/.local/bin/mabo" "$root/before"
export TEST_HTTP_FAILURE=1
runFail 1 'GitHub API request failed. Pin MABO_VERSION'
contains "$root/stderr" 'GITHUB_TOKEN'
unchanged
unset TEST_HTTP_FAILURE
runner=$savedRunner
export MABO_RELEASE_BASE_URL="file://$root/releases" MABO_API_URL="file://$root/api"

# An error at the final rename must clean the stage and preserve the old file.
cat > "$root/bin/mv" <<'SH'
#!/bin/sh
exit 7
SH
chmod +x "$root/bin/mv"
runFail 1 'Cannot replace' --version 7.1.0
unchanged
rm "$root/bin/mv"

# Duplicate/invalid checksum entries, symlink archive member, and malformed JSON
# must fail closed too, with the same preservation guarantee.
cp "$root/releases/v7.0.0/SHA256SUMS" "$root/good-sums"
cat "$root/good-sums" >> "$root/releases/v7.0.0/SHA256SUMS"
runFail 1 'Missing, duplicate, or invalid SHA256SUMS line' --version 7.0.0
unchanged
cp "$root/good-sums" "$root/releases/v7.0.0/SHA256SUMS"
sed 's/^[0-9a-f]/z/' "$root/good-sums" > "$root/releases/v7.0.0/SHA256SUMS"
runFail 1 'Missing, duplicate, or invalid SHA256SUMS line' --version 7.0.0
unchanged
cp "$root/good-sums" "$root/releases/v7.0.0/SHA256SUMS"
mkdir "$root/link-archive"
ln -s "$root/before" "$root/link-archive/mabo"
tar -czf "$root/releases/v7.0.0/maboroshi-v7.0.0-linux-x64.tar.gz" -C "$root/link-archive" mabo
asset=maboroshi-v7.0.0-linux-x64.tar.gz
digest=$(hashFile "$root/releases/v7.0.0/$asset"); digest=${digest%% *}
printf '%s  %s\n' "$digest" "$asset" > "$root/releases/v7.0.0/SHA256SUMS"
runFail 1 'Archive must contain a regular mabo executable' --version 7.0.0
unchanged
for malformed in \
    '' ' ' '[{' '[1]' '[{},]' \
    '[{"body":"bad\q"}]' '[{"body":"bad\u123x"}]' '[{"body":"unterminated}]' \
    '[{"body":01}]' '[{"body":truefalse}]' '[{"body":NaN}]' '[{"body":"line
break"}]' \
    '[{"body":false,}]' '[{"body" false}]' '[{"body":[1 2]}]' '[{"body":1e}]' '[{"body":"ok"}]#' '[{"body":"\"}]' \
    '[{"draft":false,"prerelease":false,"tag_name":"v7.1.0","assets":[{"name":"maboroshi-v7.1.0-linux-x64.tar.gz"}]}]garbage'; do
    printf '%s\n' "$malformed" > "$root/api/releases?per_page=100"
    runFail 1 'Invalid GitHub API response'
    unchanged
done
printf 'PASS: %s installer cases (%s)\n' "$count" "$runner"
