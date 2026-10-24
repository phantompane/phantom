# Installation

[README](../README.md) · [Commands](commands.md) · [JSON](json.md)

For agents and CI, pin the installer and binary to the same release tag:

```sh
curl -fsSL https://github.com/phantompane/phantom/releases/download/<TAG>/install.sh | RABI_VERSION=<TAG> sh
```

Replace `<TAG>` with a tag from the first release containing rabi or later on the [Releases page](https://github.com/phantompane/phantom/releases); that release has not been published yet. v7.0.0-alpha.9 and v7.0.0-alpha.8 must each be installed with that release's own `install.sh` at `https://github.com/phantompane/phantom/releases/download/<TAG>/install.sh`, using its original options and environment variables; v7.0.0-alpha.7 and older have no installer, so install them manually as described below. Pinned installs allow prereleases and make no GitHub API request.

Without a version pin, the installer selects the newest stable v7 release with a `rabi-` archive for the platform, skipping v6:

```sh
curl -fsSL https://raw.githubusercontent.com/phantompane/phantom/main/install.sh | sh
```

While only matching v7 prereleases exist, it stops and names the newest matching prerelease. To allow that prerelease:

```sh
curl -fsSL https://raw.githubusercontent.com/phantompane/phantom/main/install.sh | sh -s -- --prerelease
```

Pass installer options with `sh -s -- [options]`; flags override environment variables.

| Option | Environment variable | Behavior |
|---|---|---|
| `--version <TAG>` | `RABI_VERSION` | Exact release tag, with or without the leading `v` |
| `--prerelease` | `RABI_PRERELEASE=1` | Allow the newest prerelease when unpinned |
| `--install-dir <DIR>` | `RABI_INSTALL_DIR` | Install directory (default `~/.local/bin`) |
| `--verify-attestation` | `RABI_VERIFY_ATTESTATION=1` | Also verify GitHub artifact provenance; requires `gh` and aborts if verification fails |

`GITHUB_TOKEN` is optional, only for GitHub API rate limits on unpinned installs; it is not sent to asset downloads. The installer needs `curl` and `tar`; on Alpine, run `apk add curl` first. It never prompts, uses no sudo, and does not edit shell profiles; it prints a PATH hint if needed. It always verifies SHA-256 and replaces the binary atomically. It refuses to replace a symlinked `rabi` managed by another tool; update with that tool or choose another install directory.

Release binaries support Linux x64/arm64 (static musl builds for any distribution, including Alpine) and macOS x64/arm64. Windows is not supported; use WSL with the Linux binaries.

## Other installation methods

With mise, pin a version from the first release containing rabi or later; the repository also has older v6 TypeScript releases.

```sh
mise use github:phantompane/phantom@<VERSION>
```

Or build from source with Rust 1.89+ (the `rust-version` in `Cargo.toml`), using the same rabi release tag requirement:

```sh
cargo install --git https://github.com/phantompane/phantom --tag <TAG> --locked rabi
```

For a manual install, download `rabi-v<VERSION>-<os>-<arch>.tar.gz` from Releases (`<VERSION>` omits the leading `v`; `<os>` is `linux` or `darwin`, and `<arch>` is `x64` or `arm64`). Some older releases use archive names such as `mabo-v<VERSION>-<os>-<arch>.tar.gz`, `maboroshi-v<VERSION>-<os>-<arch>.tar.gz` or `ptm-v<VERSION>-<os>-<arch>.tar.gz`; for those, download the archive listed on that release. `install.sh` supports only the `rabi-` archive name and requires exactly one valid entry for it in `SHA256SUMS`. Each current archive contains only `rabi` (older archives contain the binary named at that release); extract it and place it in a directory on PATH. For releases after v7.0.0-alpha.7, download `SHA256SUMS` from the same release and verify before extracting. To verify provenance with `gh` and check SHA-256 on Linux, run these in the download directory, substituting your archive name:

```sh
gh attestation verify rabi-v<VERSION>-linux-x64.tar.gz --repo phantompane/phantom
grep " rabi-v<VERSION>-linux-x64.tar.gz$" SHA256SUMS | sha256sum -c -
```

`SHA256SUMS` covers all four archives and `install.sh`; the `grep` selects the line for the archive you downloaded, which works with GNU and BusyBox `sha256sum`. On macOS, use `shasum -a 256 -c -` instead of `sha256sum -c -`. v7.0.0-alpha.7 and older releases have no `SHA256SUMS` or artifact attestations.

## Updating

Re-run the pinned installer command above with the new release tag. mise users update their version pin with mise; Cargo users rerun the source install command with the new tag; manual users replace the binary with the newly downloaded and verified one. `rabi` has no self-update command and does not check for updates or make network calls for update checks.
