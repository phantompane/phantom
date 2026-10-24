#!/bin/sh
# Official rabi installer. Re-run to update; pin with RABI_VERSION for reproducibility.
# RABI_RELEASE_BASE_URL and RABI_API_URL are overrides for testing/mirrors;
# they accept https:// URLs and local file:// URLs (copied without HTTP).
# RABI_ATTESTATION_TIMEOUT is a test-only positive integer deadline in seconds
# (default 120); invalid values are usage errors.
# Requires curl (Alpine: apk add curl).
set -eu

usage() {
    cat <<'USAGE'
Usage: sh install.sh [options]
  --version TAG          Exact release tag, with or without v (RABI_VERSION)
  --prerelease           Allow prereleases (RABI_PRERELEASE=1)
  --install-dir DIR      Destination (RABI_INSTALL_DIR; default $HOME/.local/bin)
  --verify-attestation   Require gh attestation verification (RABI_VERIFY_ATTESTATION=1)
  -h, --help             Show this help
Re-run to update. Never prompts, uses sudo, or changes shell profiles.
Requires curl (Alpine: apk add curl).
USAGE
}

fail() { printf 'rabi installer: %s\n' "$*" >&2; exit 1; }
failRelease() {
    fail "$* This installer supports only rabi- archives. Install v7.0.0-alpha.9 or v7.0.0-alpha.8 with that release's own installer: https://github.com/phantompane/phantom/releases/download/<TAG>/install.sh (replace <TAG> with the release tag); v7.0.0-alpha.7 and older have no installer."
}
usageError() { printf 'rabi installer: %s\n' "$*" >&2; exit 2; }
progress() { printf '%s\n' "$*" >&2; }

cleanup() {
    status=$?
    if [ -n "$ghPid" ]; then
        kill -KILL "$ghPid" 2>/dev/null || :
        wait "$ghPid" 2>/dev/null || :
    fi
    stopWatchdog
    if [ -n "$stageDir" ]; then rm -rf "$stageDir"; fi
    if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
    if [ "$status" -ne 0 ]; then exit 1; fi
}

stopWatchdog() {
    if [ -n "$watchdogPid" ]; then
        kill -TERM "$watchdogPid" 2>/dev/null || :
        wait "$watchdogPid" 2>/dev/null || :
        watchdogPid=''
    fi
}

verifyAttestation() {
    GH_PROMPT_DISABLED=1 gh attestation verify "$tmp/$archive" --repo phantompane/phantom \
        </dev/null >"$tmp/attestation.log" 2>&1 &
    ghPid=$!
    (
        # A background sleep plus wait lets POSIX shells handle TERM promptly.
        # Reap the sleep too, including when TERM arrives during its startup.
        trap - 0
        stopping=0 sleepPid=''
        trap 'stopping=1; if [ -n "$sleepPid" ]; then kill "$sleepPid" 2>/dev/null || :; fi' HUP INT TERM
        pauseWatchdog() {
            sleep "$1" &
            sleepPid=$!
            if [ "$stopping" = 1 ]; then kill "$sleepPid" 2>/dev/null || :; fi
            wait "$sleepPid" 2>/dev/null || :
            if [ "$stopping" = 1 ]; then
                wait "$sleepPid" 2>/dev/null || :
                exit 0
            fi
            sleepPid=''
        }
        pauseWatchdog "$attestationTimeout"
        : > "$tmp/attestation.timed-out"
        kill -TERM "$ghPid" 2>/dev/null || :
        pauseWatchdog 2
        kill -KILL "$ghPid" 2>/dev/null || :
    ) </dev/null >"$tmp/watchdog.log" 2>&1 &
    watchdogPid=$!
    ghStatus=0
    wait "$ghPid" 2>/dev/null || ghStatus=$?
    ghPid=''
    stopWatchdog
    if [ -f "$tmp/attestation.timed-out" ]; then
        fail "Attestation verification timed out after $attestationTimeout seconds for $archive."
    fi
    [ "$ghStatus" = 0 ] || fail "Attestation verification failed for $archive."
}

refuseManagedTarget() {
    if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
        fail "$target is managed elsewhere (Homebrew, mise, cargo, or another tool). Update with that tool or pass a different --install-dir."
    fi
}

# Only this function sends authentication, and only when its third argument is api.
# Disable user curl config so it cannot enable tracing or add asset credentials.
download() {
    case $1 in
        file://*) cp "${1#file://}" "$2" ;;
        https://*)
            if [ "${3-}" = api ] && [ -n "${GITHUB_TOKEN-}" ]; then
                curl --disable -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 \
                    --connect-timeout 30 --speed-limit 1 --speed-time 60 --max-time 600 \
                    -H "Authorization: Bearer $GITHUB_TOKEN" -o "$2" "$1"
            else
                curl --disable -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 \
                    --connect-timeout 30 --speed-limit 1 --speed-time 60 --max-time 600 \
                    -o "$2" "$1"
            fi ;;
        *) fail 'Download URLs must use https:// (or file:// for testing/mirrors).' ;;
    esac
}

# Tokenize before awk: BWK awk substr/length scan long strings, so walking the
# whole JSON response character by character is quadratic. grep consumes complete
# strings/literals in one pass; the final alternative preserves invalid bytes so
# malformed input cannot disappear. Only JSON whitespace is ignored by awk.
# Parse the entire response before selecting, including metadata we do not use.
resolveRelease() {
    LC_ALL=C grep -aoE '"([^"\\[:cntrl:]]|\\(["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?|true|false|null|[[:space:]]+|.' \
        "$tmp/releases.json" > "$tmp/releases.tokens" || return 1
    LC_ALL=C awk -v platform="$os-$arch" -v allow="$prerelease" '
    function bad() { exit 1 }
    # Decode with a fixed number of linear substitutions, never a character walk.
    # The lexer has validated escapes; raw strings cannot contain the sentinel.
    function stringValue(s,    h,pattern,replacement) {
        s=substr(s,2,length(s)-2)
        if(index(s,"\\")==0) return s
        gsub(/\\\\/,"\001",s)
        gsub(/\\"/,"\"",s)
        gsub(/\\\//,"/",s)
        gsub(/\\[bfnrt]/,"?",s)
        for(h=32;h<=126;h++) {
            pattern=sprintf("%04x",h)
            gsub(/a/,"[aA]",pattern); gsub(/b/,"[bB]",pattern)
            gsub(/c/,"[cC]",pattern); gsub(/d/,"[dD]",pattern)
            gsub(/e/,"[eE]",pattern); gsub(/f/,"[fF]",pattern)
            replacement=(h==92 ? "\001" : (h==38 ? "\\&" : sprintf("%c",h)))
            gsub("\\\\u" pattern,replacement,s)
        }
        # Preserve the original ASCII-only interpretation of release metadata.
        gsub(/\\u[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]/,"?",s)
        gsub(/\001/,"\\\\",s)
        return s
    }
    function nextToken(    status) {
        do {
            status=(getline value)
            if(status<0) bad()
            if(status==0) { token=""; value=""; return }
        } while(value ~ /^[ \t\r]+$/)
        token=value
        if(substr(value,1,1)=="\"") {
            if(length(value)<2) bad()
            token="\""
        }
        else if(value=="true" || value=="false" || value=="null" ||
            value ~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) token="literal"
        else if(value !~ /^[][{}:,]$/) bad()
    }
    function parse(path,    key,child) {
        if(++depth>100) bad()
        if(token=="{") {
            if(path!="/item" && path!="/item/assets/item") path="/ignored"
            nextToken()
            if(token!="}") while(1) {
                if(token!="\"") bad()
                key=stringValue(value); nextToken(); if(token!=":") bad()
                child="/ignored"
                if(path=="/item" && (key=="tag_name" || key=="draft" || key=="prerelease" || key=="assets")) child=path "/" key
                if(path=="/item/assets/item" && key=="name") child=path "/name"
                nextToken(); parse(child)
                if(token=="}") break
                if(token!=",") bad()
                nextToken()
            }
            nextToken()
        } else if(token=="[") {
            if(path!="" && path!="/item/assets") path="/ignored"
            nextToken()
            if(token!="]") while(1) {
                child=(path=="" || path=="/item/assets") ? path "/item" : "/ignored"
                if(path=="") {
                    tag=""; draft=""; pre=""
                    for(key in assets) delete assets[key]
                    if(token!="{") bad()
                }
                parse(child)
                if(path=="" && draft=="false" && (pre=="true" || pre=="false")) {
                    ver=tag; sub(/^v/,"",ver)
                    name="rabi-v" ver "-" platform ".tar.gz"
                    if(name in assets) {
                        if(pre=="true" && firstPre=="") firstPre=tag
                        if(chosen=="" && (pre=="false" || allow==1)) chosen=tag
                    }
                }
                if(token=="]") break
                if(token!=",") bad()
                nextToken()
            }
            nextToken()
        } else if(token=="\"" || token=="literal") {
            if(path=="/item/tag_name" && token=="\"") tag=stringValue(value)
            if(path=="/item/draft" && token=="literal") draft=value
            if(path=="/item/prerelease" && token=="literal") pre=value
            if(path=="/item/assets/item/name" && token=="\"") assets[stringValue(value)]=1
            nextToken()
        } else bad()
        depth--
    }
    BEGIN {
        nextToken(); if(token!="[") bad()
        parse(""); if(token!="") bad()
        if(chosen!="") print chosen
        else if(firstPre!="") print "prerelease:" firstPre
        exit
    }' "$tmp/releases.tokens"
}

main() {
    version=${RABI_VERSION-}
    prerelease=${RABI_PRERELEASE-0}
    verify=${RABI_VERIFY_ATTESTATION-0}
    installDir=${RABI_INSTALL_DIR-}
    while [ "$#" -gt 0 ]; do
        case $1 in
            --version|--install-dir)
                if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                    usageError "$1 requires a value"
                fi
                case $1 in --version) version=$2 ;; --install-dir) installDir=$2 ;; esac
                shift 2 ;;
            --prerelease) prerelease=1; shift ;;
            --verify-attestation) verify=1; shift ;;
            -h|--help) usage; return ;;
            *) usageError "Unknown option: $1" ;;
        esac
    done
    attestationTimeout=${RABI_ATTESTATION_TIMEOUT-120}
    case $attestationTimeout in
        ''|*[!0-9]*) usageError 'RABI_ATTESTATION_TIMEOUT must be a positive integer in seconds.' ;;
    esac
    [ "$attestationTimeout" -gt 0 ] 2>/dev/null ||
        usageError 'RABI_ATTESTATION_TIMEOUT must be a positive integer in seconds.'
    if [ -z "$installDir" ]; then
        [ -n "${HOME-}" ] || fail 'HOME is unset; pass --install-dir.'
        installDir=$HOME/.local/bin
    fi
    # Absolute paths also prevent option-like destinations being treated as flags.
    case $installDir in /*) ;; *) installDir=$PWD/$installDir ;; esac
    target=$installDir/rabi
    refuseManagedTarget
    tmp='' stageDir='' ghPid='' watchdogPid=''
    trap cleanup 0
    trap 'exit 1' HUP INT TERM
    case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) os=unsupported ;; esac
    case $(uname -m) in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) arch=unsupported ;; esac
    if [ "$os" = unsupported ] || [ "$arch" = unsupported ]; then
        fail "Unsupported platform. See https://github.com/phantompane/phantom/releases or use: cargo install --git https://github.com/phantompane/phantom --tag ${version:-<tag>} --locked rabi"
    fi
    command -v curl >/dev/null 2>&1 ||
        fail 'curl is required. Install it with your package manager (Alpine: apk add curl).'
    if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
    elif command -v shasum >/dev/null 2>&1; then hasher=shasum
    else fail 'sha256sum or shasum is required for checksum verification.'; fi
    if [ "$verify" = 1 ]; then
        command -v gh >/dev/null 2>&1 || fail '--verify-attestation requires gh on PATH.'
    fi
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/rabi-install.XXXXXXXX") || fail 'Cannot create temporary directory.'
    base=${RABI_RELEASE_BASE_URL:-https://github.com/phantompane/phantom/releases/download}
    api=${RABI_API_URL:-https://api.github.com/repos/phantompane/phantom}
    if [ -z "$version" ]; then
        progress 'Resolving rabi release...'
        download "${api%/}/releases?per_page=100" "$tmp/releases.json" api 2>/dev/null ||
            fail 'GitHub API request failed. Pin RABI_VERSION or set GITHUB_TOKEN for API access.'
        version=$(resolveRelease) || fail 'Invalid GitHub API response. Pin RABI_VERSION or set GITHUB_TOKEN.'
        case $version in
            prerelease:*)
                version=${version#prerelease:}
                fail "No stable rabi release; newest prerelease is $version. Set RABI_VERSION=$version or pass --prerelease." ;;
            '') failRelease 'No matching rabi release. Pin RABI_VERSION or use --prerelease.' ;;
        esac
    fi
    ver=${version#v}
    # Tags must be safe URL/path components; do not interpret arbitrary API text.
    case $ver in ''|*[!A-Za-z0-9.+-]*) fail "Invalid release tag: $version" ;; esac
    tag=v$ver
    progress "Downloading rabi $tag..."
    download "${base%/}/$tag/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null ||
        failRelease "Missing or unavailable SHA256SUMS for $tag; refusing an unverified release."
    # Compare the complete filename, accept only one well-formed standard entry.
    archive=rabi-$tag-$os-$arch.tar.gz
    expected=$(awk -v name="$archive" '
        substr($0,67)==name && substr($0,65,2)=="  " {
            hash=substr($0,1,64)
            if(length(hash)!=64 || hash ~ /[^0-9a-fA-F]/) exit 1
            count++; result=tolower(hash)
        }
        END { if(count!=1) exit 1; print result }
    ' "$tmp/SHA256SUMS") ||
        failRelease "Missing, duplicate, or invalid SHA256SUMS line for $archive."
    download "${base%/}/$tag/$archive" "$tmp/$archive" 2>/dev/null || fail "Cannot download $archive."
    if [ "$hasher" = sha256sum ]; then actual=$(sha256sum "$tmp/$archive")
    else actual=$(shasum -a 256 "$tmp/$archive"); fi
    actual=${actual%% *}
    [ "$actual" = "$expected" ] || fail "Checksum mismatch for $archive."
    if [ "$verify" = 1 ]; then
        progress 'Verifying GitHub attestation...'
        verifyAttestation
    fi
    # Extract only the expected root member, not arbitrary paths from the archive.
    mkdir "$tmp/extracted"
    tar -xzf "$tmp/$archive" -C "$tmp/extracted" rabi 2>/dev/null || fail 'Archive is missing a regular rabi executable or cannot be extracted.'
    binary=$tmp/extracted/rabi
    if [ ! -f "$binary" ] || [ -L "$binary" ]; then
        fail 'Archive must contain a regular rabi executable.'
    fi
    chmod 755 "$binary"
    reported=$("$binary" --version 2>/dev/null) || fail 'Downloaded rabi --version failed.'
    case $reported in
        "rabi v$ver"|"rabi v$ver+"*|"rabi v$ver "*) ;;
        *) fail "Downloaded rabi version does not match $tag." ;;
    esac
    refuseManagedTarget
    mkdir -p "$installDir" || fail "Cannot create install directory: $installDir"
    # A private staging directory avoids following pre-existing staging symlinks.
    stageDir=$(mktemp -d "$installDir/.rabi.install.XXXXXXXX") || fail 'Cannot stage rabi in install directory.'
    cp "$binary" "$stageDir/rabi"
    chmod 755 "$stageDir/rabi"
    refuseManagedTarget
    mv -f "$stageDir/rabi" "$target" || fail "Cannot replace $target."
    printf 'Installed rabi v%s to %s\n' "$ver" "$target"
    case :${PATH-}: in
        *:"$installDir":*) ;;
        *) quotedDir=$(printf '%s' "$installDir" | sed "s/'/'\\\\''/g")
           progress "Add to PATH: export PATH='$quotedDir':\"\$PATH\"" ;;
    esac
    resolved=$(command -v rabi || :)
    if [ -n "$resolved" ] && [ "$resolved" != "$target" ]; then
        progress "Warning: another rabi at $resolved shadows $target."
    fi
}

# Do not consume the script stream when invoked with curl ... | sh.
main "$@" </dev/null
