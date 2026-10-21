#!/bin/sh
# Portable offline integration tests. Fixtures are generated, never downloaded.
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
unset MABO_VERSION MABO_INSTALL_DIR MABO_PRERELEASE MABO_VERIFY_ATTESTATION GITHUB_TOKEN
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
    run 1
    contains "$root/stderr" 'v7.2.0-alpha.1'
    contains "$root/stderr" 'MABO_VERSION=v7.2.0-alpha.1'
    contains "$root/stderr" '--prerelease'
    export MABO_PRERELEASE=1
    run 0
    assertVersion 7.2.0-alpha.1 "$HOME/.local/bin"
    unset MABO_PRERELEASE
done
cp "$HOME/.local/bin/mabo" "$root/before"
for broken in 7.6.0-checksum 7.7.0-nosums 7.8.0-noline 7.5.0-missing 7.4.0-wrong; do
    run 1 --version "$broken"
    unchanged
    case $broken in
        *checksum) contains "$root/stderr" 'Checksum mismatch' ;;
        *nosums|*noline) contains "$root/stderr" 'SHA256SUMS' ;;
        *missing) contains "$root/stderr" 'mabo executable' ;;
        *wrong) contains "$root/stderr" 'does not match' ;;
    esac
done

mkdir -p "$HOME/managed"
printf 'package manager binary\n' > "$root/managed-target"
ln -s "$root/managed-target" "$HOME/managed/mabo"
run 1 --version 7.0.0 --install-dir "$HOME/managed"
contains "$root/stderr" 'managed elsewhere'
[ "$(cat "$root/managed-target")" = 'package manager binary' ] || fail 'Modified symlink target'
[ -L "$HOME/managed/mabo" ] || fail 'Replaced symlink'
rm "$HOME/managed/mabo"
ln -s "$root/nonexistent" "$HOME/managed/mabo"
run 1 --version 7.0.0 --install-dir "$HOME/managed"
contains "$root/stderr" 'managed elsewhere'
rm "$HOME/managed/mabo"
mkdir "$HOME/managed/mabo"
run 1 --version 7.0.0 --install-dir "$HOME/managed"
contains "$root/stderr" 'managed elsewhere'

# A restricted PATH makes absence reproducible even on developer/CI machines
# with gh, jq, python, curl or multiple checksum implementations installed.
mkdir "$root/tools"
for tool in sh bash dash awk cat chmod cp grep mkdir mktemp mv rm sed tar uname gzip; do
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
exec /bin/sh "$@"
SH
chmod +x "$root/bin/isolated-shell"
export TEST_TOOLS="$root/tools"
savedRunner=$runner
runner=isolated-shell
run 1 --version 7.0.0 --verify-attestation
contains "$root/stderr" 'requires gh'
unchanged
cat > "$root/tools/gh" <<'SH'
#!/bin/sh
printf '%s\n' "$@" > "$TEST_GH_ARGS"
# Attempting to read must see EOF, even when the installer itself is piped.
if read -r ignored; then exit 99; fi
exit "${TEST_GH_STATUS:-0}"
SH
chmod +x "$root/tools/gh"
export TEST_GH_ARGS="$root/gh-args" TEST_GH_STATUS=1
run 1 --version 7.0.0 --verify-attestation
contains "$root/stderr" 'Attestation verification failed'
unchanged
export TEST_GH_STATUS=0 MABO_VERIFY_ATTESTATION=1
run 0 --version 7.0.0
assertVersion 7.0.0 "$HOME/.local/bin"
[ "$(sed -n '1p' "$root/gh-args")" = attestation ] || fail 'Wrong gh command'
[ "$(sed -n '2p' "$root/gh-args")" = verify ] || fail 'Wrong gh subcommand'
contains "$root/gh-args" '/maboroshi-v7.0.0-linux-x64.tar.gz'
[ "$(sed -n '4p' "$root/gh-args")" = --repo ] || fail 'Wrong gh repo flag'
[ "$(sed -n '5p' "$root/gh-args")" = phantompane/phantom ] || fail 'Wrong gh repo'
[ "$(wc -l < "$root/gh-args" | tr -d ' ')" = 5 ] || fail 'Unexpected gh arguments'
unset MABO_VERIFY_ATTESTATION
rm "$root/tools/curl"
if command -v wget >/dev/null 2>&1; then
    ln -s "$(command -v wget)" "$root/tools/wget"
    run 0 --version 7.0.0
    assertVersion 7.0.0 "$HOME/.local/bin"
    rm "$root/tools/wget"
fi
run 1 --version 7.0.0
contains "$root/stderr" 'curl or wget'
ln -s "$curlPath" "$root/tools/curl"
rm "$root/tools/$shaName"
run 1 --version 7.0.0
contains "$root/stderr" 'sha256sum or shasum'
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
run 1 --version 7.0.0
contains "$root/stderr" 'https://github.com/phantompane/phantom/releases'
contains "$root/stderr" 'cargo install --git https://github.com/phantompane/phantom --tag 7.0.0 --locked maboroshi'
export TEST_OS=Linux TEST_ARCH=riscv64
run 1 --version 7.0.0
contains "$root/stderr" 'Unsupported platform'
unset TEST_OS TEST_ARCH
run 2 --unknown
contains "$root/stderr" 'Unknown option'
run 2 --version
run 2 --install-dir
run 0 --help
contains "$root/stdout" 'Usage:'
run 0 -h
export MABO_API_URL="file://$root/nonexistent"
run 1
contains "$root/stderr" 'Pin MABO_VERSION'
contains "$root/stderr" 'GITHUB_TOKEN'
export MABO_API_URL="file://$root/api"
printf '{"message":"rate limit"}\n' > "$root/api/releases?per_page=100"
run 1
contains "$root/stderr" 'Invalid GitHub API response'

# Pipe the actual script: commands must not consume its unread source bytes.
status=0
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
# Exercise both HTTPS transports without network access. The fake clients check
# the actual security flags and require credentials only on the one API request.
mkdir "$root/http-tools"
cat > "$root/http-tools/curl" <<'SH'
#!/bin/sh
set -eu
client=${0##*/}
auth=no
secure=no
redirectSafe=no
tls=no
config=no
silent=no
headers=no
maxRedirect=no
hstsDisabled=no
if [ "$client" = curl ]; then
    [ "$1" = --disable ] || exit 90
fi
while [ "$#" -gt 0 ]; do
    case $1 in
        --disable|--no-config) config=yes; shift ;;
        -fsSL|--quiet) silent=yes; shift ;;
        --proto) [ "$2" = '=https' ] || exit 91; secure=yes; shift 2 ;;
        --proto-redir) [ "$2" = '=https' ] || exit 91; redirectSafe=yes; shift 2 ;;
        --tlsv1.2) tls=yes; shift ;;
        --no-hsts) hstsDisabled=yes; shift ;;
        --https-only) secure=yes; shift ;;
        --max-redirect=0) maxRedirect=yes; shift ;;
        --server-response) headers=yes; shift ;;
        -H) [ "$2" = "Authorization: Bearer $GITHUB_TOKEN" ] || exit 92; auth=yes; shift 2 ;;
        --header=*) [ "${1#--header=}" = "Authorization: Bearer $GITHUB_TOKEN" ] || exit 92; auth=yes; shift ;;
        -o|-O) output=$2; shift 2 ;;
        https://*) url=$1; shift ;;
        *) exit 93 ;;
    esac
done
[ "$config:$secure:$silent" = yes:yes:yes ] || exit 94
if [ "$client" = curl ]; then
    [ "$redirectSafe:$tls" = yes:yes ] || exit 94
else
    [ "$headers:$maxRedirect:$hstsDisabled" = yes:yes:yes ] || exit 94
fi
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
printf '%s %s auth=%s\n' "$client" "$kind" "$auth" >> "$TEST_ROOT/http-log"
if [ "${TEST_HTTP_FAILURE:-0}" = 1 ]; then
    printf 'Failure containing %s\n' "$GITHUB_TOKEN" >&2
    exit 22
fi
if [ "${TEST_HTTP_REDIRECT:-0}" = 1 ]; then
    printf '  HTTP/1.1 302 Found\n  Location: http://insecure.invalid/archive\n' >&2
    exit 8
fi
cp "$source" "$output"
SH
chmod +x "$root/http-tools/curl"
cp "$root/http-tools/curl" "$root/http-tools/wget"
export TEST_ROOT="$root"
writeApi compact yes
export MABO_RELEASE_BASE_URL=https://mirror.invalid/download MABO_API_URL=https://mirror.invalid/api
cp "$HOME/.local/bin/mabo" "$root/before"
for client in curl wget; do
    rm -f "$root/tools/curl" "$root/tools/wget"
    ln -s "$root/http-tools/$client" "$root/tools/$client"
    runner=isolated-shell
    : > "$root/http-log"
    run 0
    assertVersion 7.1.0 "$HOME/.local/bin"
    [ "$(cat "$root/http-log")" = "$client api auth=yes
$client asset auth=no
$client asset auth=no" ] || fail 'Incorrect HTTP requests or credential scope'
    : > "$root/http-log"
    run 0 --version 7.0.0
    [ "$(cat "$root/http-log")" = "$client asset auth=no
$client asset auth=no" ] || fail 'Pinned install called API'
    cp "$HOME/.local/bin/mabo" "$root/before"
    export TEST_HTTP_FAILURE=1
    run 1
    contains "$root/stderr" 'Pin MABO_VERSION'
    contains "$root/stderr" 'GITHUB_TOKEN'
    unchanged
    unset TEST_HTTP_FAILURE
    if [ "$client" = wget ]; then
        export TEST_HTTP_REDIRECT=1
        : > "$root/http-log"
        run 1 --version 7.0.0
        [ "$(wc -l < "$root/http-log" | tr -d ' ')" = 1 ] || fail 'Followed insecure redirect'
        unchanged
        unset TEST_HTTP_REDIRECT
    fi
done
runner=$savedRunner
export MABO_RELEASE_BASE_URL="file://$root/releases" MABO_API_URL="file://$root/api"

# An error at the final rename must clean the stage and preserve the old file.
cat > "$root/bin/mv" <<'SH'
#!/bin/sh
exit 7
SH
chmod +x "$root/bin/mv"
run 1 --version 7.1.0
unchanged
contains "$root/stderr" 'Cannot replace'
rm "$root/bin/mv"

# Duplicate/invalid checksum entries, symlink archive member, and malformed JSON
# must fail closed too, with the same preservation guarantee.
cp "$root/releases/v7.0.0/SHA256SUMS" "$root/good-sums"
cat "$root/good-sums" >> "$root/releases/v7.0.0/SHA256SUMS"
run 1 --version 7.0.0
contains "$root/stderr" 'SHA256SUMS line'
unchanged
cp "$root/good-sums" "$root/releases/v7.0.0/SHA256SUMS"
sed 's/^[0-9a-f]/z/' "$root/good-sums" > "$root/releases/v7.0.0/SHA256SUMS"
run 1 --version 7.0.0
unchanged
cp "$root/good-sums" "$root/releases/v7.0.0/SHA256SUMS"
mkdir "$root/link-archive"
ln -s "$root/before" "$root/link-archive/mabo"
tar -czf "$root/releases/v7.0.0/maboroshi-v7.0.0-linux-x64.tar.gz" -C "$root/link-archive" mabo
asset=maboroshi-v7.0.0-linux-x64.tar.gz
digest=$(hashFile "$root/releases/v7.0.0/$asset"); digest=${digest%% *}
printf '%s  %s\n' "$digest" "$asset" > "$root/releases/v7.0.0/SHA256SUMS"
run 1 --version 7.0.0
contains "$root/stderr" 'regular mabo executable'
unchanged
for malformed in '[{' '[{"draft":false,"prerelease":false,"tag_name":"v7.1.0","assets":[{"name":"maboroshi-v7.1.0-linux-x64.tar.gz"}]}]garbage'; do
    printf '%s\n' "$malformed" > "$root/api/releases?per_page=100"
    run 1
    contains "$root/stderr" 'Invalid GitHub API response'
    unchanged
done
printf 'PASS: %s installer cases (%s)\n' "$count" "$runner"
