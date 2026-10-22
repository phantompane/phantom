# mabo

mabo（Maboroshi, 幻）— 並列コーディングエージェントのためのワークスペース。

mabo はローカルの Git ワークスペースを管理し、多数のコーディングエージェントと人間が、同じリポジトリで同時に独立して作業できるようにします。ワークスペースは、ひとつのリポジトリのひとつのチェックアウトに、Git が記録しない名前、目的（PR、issue、ベース）、観測した状態を加えたものです。現在、チェックアウトの実体は Git worktree です。

Rust 版は `next` で開発し、[GitHub Releases](https://github.com/phantompane/phantom/releases) で v7 を配布しています。従来の TypeScript 版は `main` に残しており、その README は <https://github.com/phantompane/phantom/blob/main/README.md> にあります。

## インストール

エージェントや CI では、インストーラーとバイナリを同じリリースタグに固定します。

```sh
curl -fsSL https://github.com/phantompane/phantom/releases/download/<TAG>/install.sh | MABO_VERSION=<TAG> sh
```

`<TAG>` は [Releases ページ](https://github.com/phantompane/phantom/releases) の最新の `v7.*` など、リリースタグに置き換えてください。v7.0.0-alpha.8 は、そのリリース自身の `install.sh`（上記の URL で `<TAG>` を `v7.0.0-alpha.8` にしたもの）でインストールしてください。v7.0.0-alpha.7 以前にはインストーラーがないため、後述の手動インストールを使ってください。バージョン固定時はプレリリースも指定でき、GitHub API にはアクセスしません。

バージョンを固定しない場合は、v6 を除外し、使用するプラットフォーム向けの `mabo-` アーカイブがある最新の v7 安定版を選びます。

```sh
curl -fsSL https://raw.githubusercontent.com/phantompane/phantom/next/install.sh | sh
```

条件に合う v7 がプレリリースのみの場合は、その中で最新のプレリリース名を表示して停止します。そのプレリリースを許可するには、次のように実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/phantompane/phantom/next/install.sh | sh -s -- --prerelease
```

インストーラーのオプションは `sh -s -- [options]` で渡します。フラグは環境変数より優先します。

| オプション | 環境変数 | 動作 |
|---|---|---|
| `--version <TAG>` | `MABO_VERSION` | リリースタグを指定（先頭の `v` は省略可） |
| `--prerelease` | `MABO_PRERELEASE=1` | バージョン未固定時に最新のプレリリースを許可 |
| `--install-dir <DIR>` | `MABO_INSTALL_DIR` | インストール先（既定は `~/.local/bin`） |
| `--verify-attestation` | `MABO_VERIFY_ATTESTATION=1` | GitHub の成果物の来歴も検証。`gh` が必要で、検証失敗時は中止 |

`GITHUB_TOKEN` は任意で、バージョン未固定時の GitHub API のレート制限対策にだけ使い、アセットのダウンロードには送信しません。インストーラーには `curl` と `tar` が必要です。Alpine では先に `apk add curl` を実行してください。インストーラーは入力を求めず、sudo を使わず、シェルの起動ファイルを編集しません。必要なら PATH 設定のヒントを表示します。必ず SHA-256 を検証し、バイナリをアトミックに置き換えます。別のツールが管理するシンボリックリンクの `mabo` は置き換えを拒否するため、そのツールで更新するか、別のインストール先を指定してください。

配布バイナリは Linux x64/arm64（static musl ビルドで Alpine を含む各ディストリビューションに対応）と macOS x64/arm64 に対応します。Windows は未対応です。WSL では Linux バイナリを使ってください。

### その他のインストール方法

mise では v7 のバージョンを固定してください。リポジトリの **Latest** リリースは、まだ v6 の TypeScript 版 `phantom` です。

```sh
mise use github:phantompane/phantom@<VERSION>
```

Rust 1.89 以降（`Cargo.toml` の `rust-version`）でソースからビルドすることもできます。

```sh
cargo install --git https://github.com/phantompane/phantom --tag <TAG> --locked mabo
```

手動でインストールする場合は、Releases から `mabo-v<VERSION>-<os>-<arch>.tar.gz` をダウンロードします（`<VERSION>` は先頭の `v` を除いたもの、`<os>` は `linux` または `darwin`、`<arch>` は `x64` または `arm64`）。v7.0.0-alpha.8 以前のリリースは `maboroshi-v<VERSION>-<os>-<arch>.tar.gz` や `ptm-v<VERSION>-<os>-<arch>.tar.gz` など以前のアーカイブ名を使っているため、そのリリースに掲載されているアーカイブをダウンロードしてください。`install.sh` は `mabo-` のアーカイブ名のみをサポートし、`SHA256SUMS` 内に対応する有効な行がちょうど1行あることを必須とします。アーカイブの中身は `mabo` のみです。展開して PATH の通ったディレクトリに配置してください。v7.0.0-alpha.7 より後のリリースでは、同じリリースの `SHA256SUMS` もダウンロードし、展開前に検証します。`gh` で来歴を検証し、Linux で SHA-256 を確認するには、ダウンロード先でアーカイブ名を置き換えて次を実行します。

```sh
gh attestation verify mabo-v<VERSION>-linux-x64.tar.gz --repo phantompane/phantom
grep " mabo-v<VERSION>-linux-x64.tar.gz$" SHA256SUMS | sha256sum -c -
```

`SHA256SUMS` は4つのアーカイブと `install.sh` を対象とします。`grep` でダウンロードしたアーカイブの行だけを取り出すので、GNU と BusyBox のどちらの `sha256sum` でも使えます。macOS では `sha256sum -c -` の代わりに `shasum -a 256 -c -` を使ってください。v7.0.0-alpha.7 以前のリリースには `SHA256SUMS` と成果物のアテステーションはありません。

npm の `@phantompane/cli` と Homebrew の `phantom` は、従来の TypeScript 版 `phantom` v6 のままで、v7 ではありません。

### 更新

上記の固定インストールコマンドを、新しいリリースタグで再実行します。mise を使う場合は mise で固定バージョンを更新し、Cargo を使う場合は新しいタグでソースインストールのコマンドを再実行してください。手動の場合は、新しくダウンロード・検証したバイナリに置き換えます。`mabo` に自己更新コマンドはなく、更新の確認や、そのためのネットワークアクセスも行いません。

## なぜ必要か

Git はコードとチェックアウトを記録しますが、そのチェックアウトがなぜ存在するのか、片付けてよいのかは記録しません。多数のエージェントが同時に作業すると、その答えが分からなくなります。mabo は通常の Git の上でその情報を補います。リポジトリ、ブランチ、Git worktree はそのままで、`mabo` と一緒に `git` を直接使えます。

ワークスペースが分けるのはファイルとブランチです。プロセス、ポート、データベース、認証情報は分離しません。mabo はワークスペースの境界と自身の操作を扱い、サービスを並行して動かす準備はプロジェクトとそのフックが担います。

## できること

mabo はワークスペースを作成・取り込み・準備し、ベースの変更に追従させ、片付けます。

- **確保と準備。** `clone` は ghq の構成でリポジトリを配置します。`create` は作業ごとのワークスペースを用意し、`.worktreeinclude` に一致する ignored ファイルをコピーして、信頼済みリポジトリのフックを実行します。
- **情報の記録。** `set` は目的、関連する PR・issue、ベースを記録します。`list` と `show` は何がどこにあるかを表示します。
- **更新。** `sync` は fetch し、選択したワークスペースにベースの変更を取り込みます。primary を進めるには `--main` を明示します。
- **片付け。** `gc` はマージ済みブランチ、クローズ済み PR、孤立したレコードを根拠に対象を選び、`--older-than` は候補を絞り込みます。

すべてのコマンドは非対話で実行できます。JSON 対応コマンドは `command`、`ok`、`data`、`warnings`、`error` を持つ schema 2 envelope を返します。エラーは構造化され、終了コードは共通です（[機械可読 JSON](#機械可読-json) を参照）。`exec` は子コマンドの出力と終了コードをそのまま返します。人間も同じコマンドをテキスト出力で使えます。

## デフォルトは安全、違うことをしたいときは明示する

- **安全な片付け。** `gc` は `--apply` まで計画だけを表示します。dirty や履歴の保存を確認できない対象をスキップし、必要な権限を分けた `remove` のヒントを表示します。primary、デフォルトブランチ、現在のワークスペース、Git がロックしたチェックアウトは gc で保護されます。
- **一括操作は全ワークスペースを対象にします。** `sync --all` はリポジトリ内の全ワークスペースを選び、`--main` を追加すると primary も進めます。絞り込むには名前を明示します。`gc` は根拠と経過時間で候補を選び、dirty と履歴の保存を確認します。
- **公開済み履歴を既定で保ちます。** 統合が必要な場合、`sync` は公開済みの作業にベースをマージします。ベースに含まれないコミットがひとつでも既知のリモート追跡参照または設定済みの fetch 先から到達できれば、公開済みと扱います。
- **非対話では mabo 自身が入力を待ちません。** 空でない `CI`、JSON 出力、`--no-input`、空でも `0` でもない `MABO_NO_INPUT`、標準入力または標準エラー出力が端末でない場合が該当します。未信頼フックが必要な操作は変更前に終了コード 4（JSON の `untrusted`）で拒否します。`gc` はその削除をスキップし、スキップ自体はエラーにしません。先に `mabo trust add` するか、`create --no-setup` / `setup --no-hooks` / `remove --no-hooks` / `gc --no-hooks` を使います。ネットワーク Git 操作には `GIT_TERMINAL_PROMPT=0` を渡し、フックと gh の標準入力は `/dev/null` にします。

## 目指さないこと

mabo は次の役割を担いません。

- エージェントの実行・スケジューリング（起動、監視、割り当て）。
- タスク管理・PR ボット（担当割り当て、レビュー、コメント、マージ）。
- 日常の Git 操作の置き換え（コミット、push、履歴編集。対象はベースの統合のみ）。
- サンドボックスや実行環境基盤（コンテナ、依存関係、シークレット、ポート、データベース。実行するのはプロジェクトフックのみ）。
- 端末・セッション管理（tmux、ペイン、ダッシュボード。提供するのはパス）。
- セキュリティ上の隔離やエージェント間のアクセス制御。

## 機械可読ヘルプ

破壊的変更は [CHANGELOG.md](CHANGELOG.md#unreleased) を参照してください。

`--version` と `-v` はアプリのバージョンを表示します。`mabo --version --json` は `command: "--version"` の schema 2 envelope を返し、アプリのバージョンは `data.version`、テキストのバージョン行は `data.display` に入ります。

`show`、`path`、`list`、`exec` は記録を変更せず、`gc --older-than` は `createdAt` を使います。

`mabo help [COMMAND...]` は `--help` と同じテキストを表示します。`mabo help --json` は `data` に help-data.json 全体（`commands`、全コマンドとフラグの `helps`、`globalOptions`、`exitCodes`、`errorCodes`、`warningCodes`、`schemaVersion: 2`）を返します。`mabo help repo show --json` は同じ契約と、そのコマンドの `data.selected` を含みます。

## コマンド一覧

共通オプションは `-R/--repo REF`、`--output text|json`、`--json`、`--no-input`、`-h/--help`、`-v/--version` です。出力の例外は後述します。

| コマンド | 目的 |
|---|---|
| `mabo create` | 新規・既存ブランチ、PR、issue、detached commit から作成 |
| `mabo adopt` | 既存 linked checkout を setup なしで記録 |
| `mabo list` | 全ワークスペースを一覧表示 |
| `mabo show` | 意図と観測状態を確認 |
| `mabo path` | パスだけを出力 |
| `mabo set` | 目的・base・リンクを更新 |
| `mabo setup` | primary の ignored ファイルをコピー後、信頼済み setup を実行 |
| `mabo exec` | ワークスペースで子コマンドを実行 |
| `mabo sync` | 選択 workspace を fetch・同期し --main で primary を明示的に更新 |
| `mabo remove` | ワークスペースを片付け、保存を証明したブランチを削除 |
| `mabo forget` | ファイル・ブランチを残して記録を削除 |
| `mabo gc` | 片付けを計画し --apply で適格な候補を削除 |
| `mabo clone` | ghq 構成に clone して登録 |
| `mabo repo` | リポジトリを登録・検出・確認 |
| `mabo repo add` | リポジトリを登録 |
| `mabo repo list` | 登録・検出したリポジトリを表示 |
| `mabo repo show` | リポジトリの詳細を表示 |
| `mabo repo forget` | ファイルを残して登録解除 |
| `mabo trust` | リポジトリフックの信頼を管理 |
| `mabo trust add` | フックを表示して確認なしで信頼を記録 |
| `mabo trust remove` | フックの信頼を解除 |
| `mabo trust list` | 信頼済み common directory を表示 |
| `mabo config` | ユーザー設定を読み書き |
| `mabo config get` | 有効な設定値を表示 |
| `mabo config set` | 設定値を書き込み |
| `mabo config unset` | 設定値を削除 |
| `mabo config list` | 有効な全設定を表示 |
| `mabo help` | テキストヘルプまたは機械可読の全契約を表示 |
| `mabo completions` | bash/zsh/fish の補完スクリプトを出力 |
| `mabo shell-init` | bash/zsh/fish の mabo cd 関数を出力 |
| `mabo --version` | アプリのバージョンを表示 |

## 日常のフロー

各フローは独立した例です。デフォルトブランチを設定したリポジトリから始め（例は `origin/main`）、確認する名前のワークスペースを先に作成してください。GitHub の issue・PR 操作には認証済み `gh` が必要です。例の番号は、そのリポジトリのリンクに置き換えてください。

### issue を受けて片付けるまで

```sh
export MABO_NO_INPUT=1
mabo create --issue 812 --base origin/main --json
cd "$(mabo path issues/812)"
# Edit, test, commit, push, and open a PR with Git and gh.
mabo set --pr 853 --json
mabo sync --json
mabo show pr:853 --json
# After the work is integrated, return to primary before removing the checkout.
primary=$(mabo repo show --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["repo"]["root"])')
cd "$primary"
mabo remove pr:853 --json
mabo gc --json
```

公開済みの作業で統合が必要な場合は auto が merge を選びます。競合時は終了コード 5 で復元します（`--keep-conflicts` 指定時を除く）。削除時は保存を証明できたブランチだけを削除し、それ以外は警告付きで残します。部分削除で終了コード 6 になったら原因を直し、返された再試行コマンドを使います。

### 同じリポジトリで複数のエージェントが作業する

```sh
mabo create feat/a1-task --base origin/main --purpose 'a1: fix X' --json
mabo exec feat/a1-task -- git status
(cd "$(mabo path feat/a1-task)" && mabo sync --json)
mabo list --json
mabo sync --all --dry-run --json
mabo sync --all --json
```

各エージェントは名前やパスを作業ログに残します。引き継ぎはその名前やパスを伝えるだけです。一括 sync は適切なタイミングで実行してください。所有者や使用中の検出はありません。

### シェルから確認して片付ける

```sh
eval "$(mabo shell-init bash)"
mabo list
mabo cd issues/812
mabo gc
mabo gc --apply
```

zsh・fish では「シェル補助」の初期化を使います。gc は先に計画を表示し、`--apply` で適格な候補を削除します。現在のワークスペースなど保護された候補はスキップします。

## ユーザー設定

設定は `$XDG_CONFIG_HOME/mabo/config.toml`（既定 `~/.config/mabo/config.toml`）に保存します。`mabo config get`、`set`、`unset`、`list` で読み書きし、最初の `set` でディレクトリとファイルを作ります。

設定・状態・metadata・既定のワークスペース保存先は `mabo` パスだけを使います。project marker は `.mabo-common-dir`、discovery と古い clone staging の片付けは `.mabo-clone-` を認識します。

```toml
workspace-root = "../mabo-workspaces"
discover-ghq = true
clone-root = "~/ghq"
```

`workspace-root` 未設定時、`mabo create` は `$XDG_DATA_HOME/mabo/workspaces/<checkout>-<hash>/<name>` に配置します。`XDG_DATA_HOME` が未設定・空・相対パスなら `~/.local/share/mabo/workspaces/...` です。`<checkout>` は正規化した primary のディレクトリ名で、英数字・`.`・`_`・`-` 以外は `-` に置き換えます。シンボリックリンク経由でも同じ場所です。`<hash>` は正規化した Git common directory の SHA-256 の先頭 8 桁で、同じ remote の別 clone は別ディレクトリになります。名前内の `/` は階層として保持します。最後の削除後も repo ディレクトリと `.mabo-common-dir` は残し、同時・後続の作成で使えます。`mabo/workspaces/<id>.json` に記録した linked checkout は adopt した場所や別の workspace-root にあっても remove/gc の対象です。記録がなく、設定した保存先の外にある checkout は残します。空の親は解決済み保存先以下だけを片付けます。`workspace-root` は絶対パス、`~/`、リポジトリルートからの相対パスを受け取り、空になっても指定ディレクトリは残します。

`clone-root` は `mabo clone` の配置先で、絶対パスか `~/` を指定します。未設定なら最初の `git config ghq.root`、`$GHQ_ROOT`、`~/ghq` の順です。明示した場合は git config を読みません。ghq.root の読み取りが失敗すると警告し、残りの既定値へ進みます。`repo list` も同じディレクトリを走査します。

`config get KEY` と `config list` は既定値を含む有効値を返します。`--sources` は `value`、`source`（`config`、`env`、`default`）、`detail` を表示します。JSON は `data.config[KEY]` で、`--sources` なしなら値だけです。既定値は `workspace-root` が null（XDG 配置）、`discover-ghq` が true。clone-root はユーザー設定の下で ghq.root → `$GHQ_ROOT` → `~/ghq` の順です。`sync.strategy` は `auto`（既定）/`rebase`/`merge`、`sync.rewrite-published` は真偽値（既定 false）で、sync フラグが優先します。不正な値は終了コード 2。ユーザー config.toml の `[sync]` に置き、リポジトリ `.mabo.toml` には置けません。

```sh
mabo config list --sources
mabo config get clone-root --sources --json
mabo config set workspace-root ~/workspaces
mabo config unset workspace-root
```

## リポジトリの clone

`mabo clone` は `<root>/<host>/<owner>/<repo>` に clone して登録します。`owner/repo` は `github.com` を使います。https、http、ssh:// URL、scp 形式 `git@host:owner/repo`、`host/owner/repo`、`owner/repo` を受け取ります。host は小文字化し、URL の port も含めます（`example.net:9443`）。`file://` は拒否します。ローカルパスにはこの配置に必要な host/owner/repo がありません。中断した clone は宛先の隣に `.mabo-clone-<pid>-<uuid>` を残すことがあり、後続の clone が記録したプロセスの終了を確認して削除します。

```bash
mabo clone phantompane/phantom
mabo clone git@github.com:phantompane/phantom.git --branch next
mabo clone github.com/phantompane/phantom --depth 1
mabo clone phantompane/phantom --update
```

同じパスが同じリポジトリなら再 clone せず登録し、パスを表示します。`--update` はこのとき origin を fetch します。別リポジトリなら使用方法エラーです。`--branch` と `--depth` は新規 clone だけに適用します。

認証は Git に任せ、gh は呼びません。進捗は標準エラー出力です。新規ワークスペースは `$XDG_DATA_HOME/mabo/workspaces/<checkout>-<hash>`（`XDG_DATA_HOME` が未設定・空・相対パスなら `~/.local/share/mabo/workspaces/...`）に作ります。正規化した primary の名前と Git common directory の SHA-256 先頭 8 桁を使い、シンボリックリンクでも同じです。common directory は trust のキーと同じです。`workspace-root` で上書きでき、相対値は repo root から解決します。

## リポジトリの登録

```sh
mabo repo add [PATH]
mabo repo list [--registered | --discovered] [--names | --paths]
mabo repo show [REF]
mabo repo forget REF
```

`repo add` は省略時に選択したリポジトリまたは現在の checkout の primary を登録します。`repo list` は登録と検出を統合し、登録済みルートを優先します。`--registered` は検出せず、`--discovered` は検出した未登録ルートだけを表示します。`discover-ghq=false` は検出を無効にします。`repo show` は `repo.root`、`name`、`defaultBranch`（不明は null）、`.mabo.toml` の `configPresent`、`trusted`（`MABO_TRUST_ALL=1` を含む）、`workspaceRoot` を返します。REF は登録 ID、パス、正規名、一意な末尾を受け取り、省略時は `-R` または現在のリポジトリです。`repo forget` は登録だけを削除し、ファイルやワークスペースは残します。検出で引き続き見える場合があります。

## 対象リポジトリの指定

共通の `-R/--repo` で対象を選べます。ワークスペース操作（`create`、`adopt`、`forget`、`list`、`show`、`path`、`remove`、`sync`、`gc`、`exec`、`set`、`setup`）で `--repo <ref>`（`-R`）を使うと、現在位置以外のリポジトリを操作できます。コマンドの前やオプションの間に置けます。`mabo exec` は例外で、mabo のオプションを SEL より前に置き、必須の `--` で子コマンドを区切ります。それ以後はそのまま子に渡します。次の例は owner/repo の feature で `pwd --repo y` を実行します。

```bash
mabo exec --repo owner/repo feature -- pwd --repo y
mabo list --repo ~/src/foo --json
```

`/`、`.`、`~` で始まる ref はディレクトリです。linked checkout 内も含めリポジトリ内のどこでも指定でき、primary に解決します。`.worktreeinclude` とコピー元は選択した primary です。`-R` 指定時のフックは選択した primary、それ以外では実行元 checkout から読みます。`setup` と `remove` は `--source-checkout` でフック元を上書きできます。

それ以外の ref は登録済み・検出済みの一覧（`repo list` と同じ集合で、`discover-ghq=false` の設定も反映）と照合します。正規名 `host/owner/repo` は http(s)/ssh/scp の origin URL、なければ `<root>/<host>/<owner>/<repo>` の配置から得ます。`backups/widget.git` のようなローカル・相対 origin は host 名になりません。`owner/repo` や `repo` は一意なら使えます。repo list に表示したディレクトリ名や、remote と違う配置名も一致します。複数一致は候補付きの終了コード 2、一致なしは 3。存在しないパスはその旨を表示して 3。`-` で始まる `--repo` の値は使用方法エラーです。

## ワークスペースの選択と確認

`SEL` は名前、`.`（現在位置を含む checkout）、`pr:N`、`issue:N`、PR/issue URL、絶対パス、`./` または `../` で始まるパスを受け取ります。リンクの指定は記録済みだけを探し、新規作成しません。一致なしは 3（`not_found`）、複数は 2（`ambiguous`）。URL は記録したリポジトリとリンクに一致し、`pr:N` / `issue:N` は選択したリポジトリ内を探します。`.` と別リポジトリの `-R` は 2、リポジトリ外の現在位置は 3 です。

`show [SEL]`、`path [SEL]`、`set [SEL]`、`setup [SEL]`、`exec [SEL] -- COMMAND [ARG...]` は省略時に `.` を選びます。primary 内なら primary を指します。`show` は primary と、保存先外の未記録 checkout を `managed:false` で表示します。sync/remove の位置引数も同じセレクタです。sync 省略時は現在のワークスペースだけ（primary では `--main`）。remove はセレクタ必須で、安全判定も維持します。

```sh
mabo show --json
mabo show pr:774 --json
mabo path issue:12
cd "$(mabo path feature/auth)"
mabo set --purpose 'fix checkout' --pr 774 --base origin/main
mabo set feature/auth --unset purpose --unset base --unset pr --unset issue
mabo exec -- git status
mabo exec feature/auth -- npm test
mabo sync pr:774
```

`path` のテキストは絶対パスと改行だけ、JSON は `data: {path}`。`show` と `set` は `data.workspace` です。`show`、`path`、`list`、`exec` はレコード内容・mtime を変更しません。`set` は指定した purpose/base/pr/issue をアトミックに置き換え、省略分は保持します。`--unset FIELD` は1回で purpose/base/pr/issue のひとつを消し、複数なら繰り返します。不正フィールドや同じフィールドの設定・削除併用は拒否します。`--base` は ref を検証・正規化し、コミットも受け取ります。`--unset base` は既定ベースを補わず不明にし、`mabo set <name> --base REF` まで sync は `base-unknown` でスキップします。base フィールドのない記録は既定ベースを使います。

`list` は primary を含みます。`--kind workspace` / `--kind primary` で絞り、`--names` / `--paths` はシェル用です。`--all-repos` は repo list の登録・有効な検出の全対象を表示し、`-R` と併用できません。JSON は `data.repos` と平坦化した `data.workspaces` を含みます。人間向け出力はリポジトリ名と primary パスの見出し、現在位置 `*`、名前、ブランチ、進み・遅れ `↑a ↓b`、dirty、リンク `#12` / `issue #34`、ok 以外の setup 状態（`setup:failed` など）、目的です。削除済み upstream は `upstream:gone` と表示します。

exec は子の出力と終了コードを維持し、`MABO_OUTPUT` を無視して明示的 JSON を拒否します。使用方法エラーと付随するヘルプは標準エラー出力に出し、テキストの標準出力は空です。

## シェル補助

起動ファイルでディレクトリ移動と補完を別々に読み込みます。

```bash
# ~/.bashrc
eval "$(mabo shell-init bash)"
eval "$(mabo completions bash)"
```

```zsh
# ~/.zshrc (run compinit before loading completions)
autoload -Uz compinit
compinit
eval "$(mabo shell-init zsh)"
eval "$(mabo completions zsh)"
```

```fish
# ~/.config/fish/config.fish
mabo shell-init fish | source
mabo completions fish | source
```

定義するのは `mabo` 関数だけです。`mabo cd [SEL] [-R REF]` は `command mabo path` をテキストで解決し、成功時だけ移動します。検索失敗時は現在位置、診断、終了コードを保ちます。repo オプションは `mabo -R owner/repo cd feature` のように cd の前にも置けます。`-` で始まる名前は `mabo cd -- -leading-name` とします。`mabo cd './workspace with spaces'` のような空白・引用符・末尾改行のあるパスも保ちます。他の呼び出しは全引数を `command mabo` にそのまま渡します。セッション・ペインは作らず、shell-init は補完を読み込みません。

補完のコマンド・サブコマンド・フラグは help-data.json から生成します。セレクタ候補は補完時の `command mabo list --names` から得て、失敗時は候補なしです。`-R/--repo` をクエリに反映します。Bash は挿入前に引用し、zsh/fish は各シェルの補完引用を使います。fish/zsh は説明も表示します。任意の Git ref、`exec --` 以後の子コマンド、すべてのオプション値までは補完しません。

両スクリプトコマンドは bash/zsh/fish 必須で、省略・不明なシェルはヒント付きで 2。`MABO_OUTPUT` を無視し、明示した `--json` / `--output json` は 2 で拒否します。`mabo help completions`、`mabo help shell-init`、`mabo help --json` でも契約を確認できます。

## gitignored ファイルのコピー

`mabo create` と `mabo setup` は **primary checkout** の `.worktreeinclude` を読み、そこからコピーします。サブディレクトリや別ワークスペースから実行しても同じです。gitignore 構文で指定し、一致して Git が無視しているファイルだけをコピーするため、追跡ファイルは複製しません。

```text
.env
.env.local
config/secrets.json
```

対象に既存ファイルがあれば保持します。シンボリックリンクはスキップして辿りません。`.worktreeinclude` 自体がリンクなら読みません。

`--copy-file` でパターンを追加できます。`mabo create staging --copy-file .env --copy-file config/secrets.json` のように繰り返します。これも ignored の一致だけをコピーします。

## setup の再実行

```sh
mabo setup feature-auth                     # copy, then run trusted setup hooks
mabo setup --no-hooks --copy-file '*.env'    # current workspace, copying only
mabo create feature-auth --no-setup         # prepare later
```

`setup [SEL]` は `.` が既定で、共通セレクタを使います。コピー元の primary は 4（`primary`）で拒否します。未信頼の setup フックは **コピーや記録更新前に** 4（`untrusted`）で拒否します。対象なしは 3、コピー・フック失敗は 1、成功は 0。既存ファイルは保持し、コピー失敗ならフックを実行しません。

create の setup 失敗で 6 になったら、bash/zsh でエラーの再試行ヒント `cd '/absolute/source/checkout' && mabo setup 'SELECTOR'` を実行します。元 checkout のフック設定と、名前または一意な PR/issue セレクタを保ちます。一意に解決できなければ `(cd WORKSPACE && mabo setup . --source-checkout SOURCE)` で元の設定と dot の選択を保ちます。source は同じリポジトリ必須です。全 `--copy-file` パターンを保持し、制御文字は ANSI-C 引用 `$'...'` を使います。`create NAME --reuse` は一致対象を返すだけで setup を再実行しません。フックは再実行に耐える必要があります。

共通ワークスペース JSON の setup は `{state, at, error}`、未記録（forget 後を含む）は null です。新規作成は pending → running → ok/failed、`--no-setup` は skipped。setup 情報のない記録（adopt を含む）は unknown で時刻とエラーは null。各試行の時刻・エラーを記録し、成功時はエラーを消します。`data.setup` はその呼び出しの ran/ok/command/exitCode/signal も持ち、`data.copy` は copied/error です。

running は内部で PID と host を記録します。同じ host で PID が消えていれば、記録を書き換えず interrupted と観測します。別または不明な host は running のままです。情報表示だけで、ロックや操作の阻止には使いません。同じレコードの同時更新は後勝ちです。

## リポジトリフック

`.mabo.toml` は実行元 checkout、`-R/--repo` 指定時は選択した primary から読みます。setup/remove は `--source-checkout PATH` で同じリポジトリの別 checkout を指定できます。`.worktreeinclude` とコピー元は常に primary です。

```toml
[hooks]
setup = ["pnpm install"]
pre-remove = ["./scripts/teardown.sh"]
```

create/setup はコピー後に対象で setup を実行します。再実行可能にしてください。remove/gc --apply は削除前に対象で pre-remove を実行します。順に実行し、最初の失敗で止まります。不明キーは拒否します。

フックには信頼が必要です。コピーはフックではなく信頼不要です。フックなしなら質問しません。

端末ではリポジトリパスとフックを表示し、`Trust this project and run its hooks? [y/N]` と聞きます。y/yes は信頼を保存して実行します。空でない CI、no-input、MABO_NO_INPUT 有効時、stdin/stderr が非端末、JSON 時は聞かず、変更前に 4 で拒否します。JSON は stdout に untrusted のエラー envelope を1件返し、trust add または create の no-setup、setup/remove/gc の no-hooks を案内します。

`mabo trust add [REPO]` は stderr にフックを表示し、確認なしで信頼を記録します。`mabo trust remove [REPO]` で解除し、`mabo trust list` は common directory と許可時刻を表示します。REPO は -R と同じパス・名前で、省略時は -R または現在の repo です。信頼は正規化した Git common directory をキーとし、primary と linked checkout で共有します。同じパスへの再 clone も trust remove まで信頼が残り、フック編集でも再確認しません。人間の端末では create/setup/remove 中に質問できます。

信頼記録は絶対パスの `$XDG_STATE_HOME/mabo/trust.toml`、それ以外は `~/.local/state/mabo/trust.toml` です。各項目は path と trustedAt を保存します。

`MABO_TRUST_ALL=1` はそのプロセスだけ全 repo を信頼し、ファイルには書きません。値は厳密に `1` です。CI・コンテナで使えます。`create --no-setup` はコピーとフックを省略します。`setup --no-hooks` はコピーだけ、remove/gc --no-hooks は削除フックだけ省略します。信頼は記録しません。no-setup と copy-file は併用不可です。

gc は端末でも質問しません。pre-remove のある未信頼 repo は `untrusted hooks` として候補をスキップし、他の対象は続行します。`--no-hooks` はフックを実行せず削除します。

フックと `mabo exec` の環境変数は共通です。

- `MABO` — `1`
- `MABO_WORKSPACE` — ワークスペース名
- `MABO_WORKSPACE_ID` — 記録した ws_ ID、未記録は空
- `MABO_WORKSPACE_PATH` — ワークスペースの絶対パス
- `MABO_REPO_PATH` — フック元が linked checkout でも primary の絶対パス

## 機械可読 JSON

`--json` は `--output json` の別名で、stdout に envelope を1件だけ出します。進捗、フック、Git の出力は stderr に出します。`--output text` は人間向けテキストです。パーサーは未知のフィールドを無視してください。

```json
{
  "schema": 2,
  "command": "show",
  "ok": false,
  "data": null,
  "warnings": [],
  "error": { "code": "not_found", "message": "Workspace 'topic' not found" }
}
```

command は set や repo list のような空白区切りの名前です。data はコマンド結果で最上位 schema はなく、アプリの data.version は --version のみです。error は成功時 null、それ以外は安定した code、人間向け message、任意の details を持ちます。setup 失敗や remove/gc/sync の item 結果も data に残ります。item エラーは各 item に置きます。warnings は code/message のオブジェクトで、メタデータ読み取り・更新失敗や PR 状態の取得不可などを含み、stderr にも出る場合があり、`workspace` などの補助フィールドを含むこともあります。

| 終了コード | 意味 | error.code の例 |
|---|---|---|
| 0 | 成功（保護対象を含む gc 計画も含む） | |
| 1 | 操作失敗 | `failed`, `git_failed`, `io`, `command_failed`, `spawn`, `signaled` |
| 2 | 不正な呼び出し | `usage`, `ambiguous` |
| 3 | 対象なし・リポジトリ外 | `not_found`, `branch_not_found`, `not_repository` |
| 4 | 変更前の安全判定による拒否 | `dirty`, `unpreserved`, `published`, `exists`, `exists_remote`, `untrusted`, `primary`, `refused` |
| 5 | sync 競合（復元、または `--keep-conflicts` で保持） | `conflict` |
| 6 | 永続的変更後の失敗・部分成功 | `partial` |

refused は具体的原因がない安全拒否の既定です。テキストも同じ終了コードです。単体 exec は 128+signal を含む子の終了コードを維持します。create の setup 失敗は 6 で、workspace と data.setup.exitCode を保持します。作成後のメタデータ保存・コピー失敗も 6。remove は全セレクタと安全判定を先に検証し、その後の失敗は永続的削除があれば 6、それ以外は原因の終了コードです。item 結果を保持します。不明セレクタは dry-run でもフック・削除前に 3。6 の後は error.details.retryCommand（テキストにも表示）で未完了だけを再試行してください。元のコマンドは完了済みの対象により 3 になる場合があります。

`MABO_OUTPUT=json|text` は既定値を選び、空は未設定、不正値は 2。明示フラグが優先です。コマンド不明や共通オプションの後にコマンドがない場合も JSON 時は usage envelope です。list と repo の `--names` / `--paths` は環境が JSON でもテキストを選び、明示 JSON との併用は使用方法エラーです。exec/completions/shell-init と --help のテキストは MABO_OUTPUT を無視します。--version/help は出力モードに従います。exec/completions/shell-init の明示 JSON は使用方法エラー。必須の exec -- 以後は子の引数です。

非対話条件は空でない CI、JSON、no-input、空でも 0 でもない MABO_NO_INPUT、非端末の stdin/stderr です。未信頼フックは変更前に 4 で trust add / create --no-setup / setup --no-hooks を案内します。ネットワーク Git には GIT_TERMINAL_PROMPT=0、フック・gh の stdin は /dev/null、単体 exec は stdin を引き継ぎます。

### ワークスペースオブジェクト

current は現在位置を含む checkout、repo は primary root と名前です。primary と保存先外の未記録 checkout は managed:false。upstream は未設定なら null、設定済みは `{ref,ahead,behind,gone}`。ref は完全修飾で、gone または取得不能なら件数は null。不明なメタデータや状態は null。孤立レコードの branch/head/dirty/detached は null。読み取りで時刻を捏造しません。

list/show/create/adopt/set/remove は共通オブジェクトを使い、結果は workspace/workspaces キー（items 内も同じ）、sync は main/items です。path は絶対パス。head は完全 SHA、不明は null。detached:true の branch は null。base はそのコマンドの開始 commit-ish が分かればそれ、そうでなければ記録した同期先（refs/remotes/origin/main など）で、base が未記録なら null。list --json は記録した base です。dirty は変更・ステージ済み追跡ファイル（submodule 変更を含む）か ignored 以外の未追跡があれば true で、Git status の表示設定に左右されません。kind は primary または workspace です。

```json
{
  "id": "ws_12345678-1234-4000-8000-123456789abc",
  "name": "feature/add-tests",
  "current": false,
  "repo": {"root": "/home/user/ghq/github.com/acme/demo", "name": "github.com/acme/demo"},
  "managed": true,
  "orphaned": false,
  "upstream": null,
  "path": "/home/user/.local/share/mabo/workspaces/repo-6b4ca2db/feature/add-tests",
  "branch": "feature/add-tests",
  "head": "0123456789abcdef0123456789abcdef01234567",
  "base": "refs/heads/main",
  "dirty": false,
  "kind": "workspace",
  "detached": false,
  "purpose": "fix the flaky checkout test",
  "createdAt": "2026-10-18T11:46:00.000Z",
  "updatedAt": "2026-10-18T11:46:00.000Z",
  "createdFrom": "0123456789abcdef0123456789abcdef01234567",
  "setup": {"state": "ok", "at": "2026-10-18T11:46:00.000Z", "error": null},
  "links": {
    "pr": { "number": 774, "url": null },
    "issue": null
  }
}
```

id/purpose/base/createdAt/updatedAt/createdFrom/setup/links は Git common directory（`git rev-parse --git-common-dir`、通常 `.git`）の `mabo/workspaces/<id>.json` に保存します。create が記録し、pr/issue は `{number,url}` または null。番号だけなら url は null、http(s) URL は保持し、pull/pulls/issues/issue の番号を解析します。create --pr/--issue は対応リンクと `https://<host>/<owner>/<repo>/pull/<number>` または issues URL を補います。show/path/list/exec は記録を変更しません。remove は Git 削除後に記録を消し、create は同パスの記録を置き換え、set は意図だけ更新します。PR ブランチの reuse は作成情報を保ちつつ欠けた PR リンクを追加できます。create の metadata は `{ok:true,error:null}`。保存失敗後もコピー・フックを実行し、metadata.ok:false と理由を返し、6 partial で data を保ちます。

破損レコードがあっても list/show/exec は警告と null メタデータで続行し、他は読めます。create/setup/adopt/forget/remove/set/sync は拒否して元を保ち、sync は fetch 前に検証します。同パスの初回同時登録は最古の createdAt、同時なら辞書順で最小の ID にまとめ、全フィールドをその記録から取り、次の書き込みで余分なファイルを削除します。createdFrom は作成元の完全 commit、または固有コミットがない状態で sync が最後に fast-forward した base です。新規ブランチは HEAD、既存ブランチは最古の refs/heads reflog（なければ null）。set や後続 checkout は変更しません。adopt 記録の createdFrom は null。Git で直接作った checkout（primary も含む）は set/adopt/PR reuse までメタデータが null です。prunable/locked などの診断フィールドは将来 schema を変えず追加できます。

各レコードは schema:2、ws_<uuid v4> の id、path、任意の name と上記メタデータです。JSON の id は未記録なら null。同じディレクトリの一時ファイル、fsync、rename でアトミックに置き換えます。削除はそのレコードだけ。異なるレコードの同時追加は両方残り、同じレコードの同時更新は後勝ちです。

repo 登録は `$XDG_STATE_HOME/mabo/repos/<id>.json`（既定 `~/.local/state/mabo/repos/<id>.json`）で ID は proj_<uuid> 形式です。同じ root は最古 createdAt、同時なら最小 ID にまとめます。内部ファイルロックはなく、trust/config は単一ファイルをアトミックに置き換えます。

### Sync

```sh
mabo sync [SEL... | --all | --main] [--auto | --rebase | --merge] [--rewrite-published] [--keep-conflicts] [--dry-run]
```

引数なしはサブディレクトリでも現在のワークスペースだけです。primary なら --main と同じで、デフォルトブランチ上のときだけ fast-forward、他は not-default-branch でスキップします。通常の workspace sync は primary を暗黙に進めません。--main 単独は primary、sync . --main は現在と primary。--all は全 workspace で SEL とは併用不可（2）、primary を含めるには --main を追加します。

```sh
mabo sync
mabo sync feature/auth feature/tests --merge
mabo sync . --main --dry-run --json
mabo -R owner/repo sync --all
mabo sync feature/auth --rebase --rewrite-published
mabo sync feature/auth --keep-conflicts
mabo set feature/auth --base origin/main
```

base を設定した fetch refspec で remote に対応付け、関係する remote を各1回 fetch します。push・upstream 変更・フック実行はせず、status/rollback も Git hooks と fsmonitor を無効にします。dry-run も fetch しますが checkout/index/local branch/record は変えず plan:true。予定を status/detail に示し、将来の merge/rebase SHA は after:null。計画で実際の公開履歴書き換えは報告しません。

実行も計画も実行元 repo で通常の git fetch を使います。fetch/統合の前に全対象 remote の全 fetch refspec を検証し、正の refspec の書き込み先が refs/remotes/ 外（明示 refs/tags/ や mirror を含む）なら 4 refused です。負の除外があっても拒否し、宛先なし・空なら FETCH_HEAD だけなので許可します。独自名前空間も追跡先を refs/remotes/ 以下にしてください。git for-each-ref に見える refs/remotes/ または refs/tags/ の symbolic ref が refs/remotes/ 外を指す場合も拒否し、修復・削除が必要です。Git が列挙しない dangling symbolic ref は検出できません。通常の Git と共通の制限です。pruning、自動タグ追従、負の除外、followRemoteHEAD は Git 設定のままです。自動タグ追従は明示 refspec とは別です。複数対象の計画は primary と先行 workspace の予定 tip を順に base に反映します。キーは完全 ref で、短いブランチ名 refs/heads/a は refs/heads/refs/heads/a、ブランチ a は refs/heads/a と独立です。先行 tip が不明なら依存対象は updated、after:null、strategy:null と detail の説明を返し、古い base で判断しません。

create は正規化した base を記録し、base 未記録かつ明示的に消されていない場合は既定 base に戻ります。set --unset base や base なし adopt は base-unknown で、set --base REF が必要です。消えた base は base-gone と修復ヒントです。明示的に消した base 自体では fetch しません。

戦略の優先順位は --auto/--rebase/--merge、ユーザー sync.strategy、auto です。base..branch の固有コミットが観測済みリモート追跡 ref、設定した fetch 先、upstream のどれからも到達できなければ rebase、そうでなければ merge。独立したローカルブランチや今回 fetch しない remote の宛先も公開根拠で、現在のブランチ自身だけを除きます。公開済みの明示 rebase は --rewrite-published か sync.rewrite-published=true がなければ 4 published とヒントです。許可は戦略を選ばず、auto は公開済みを引き続き merge します。strategySource（flag/config/default）と rewriteAllowed/rewriteSource（flag/config/null）は別で、明示 false の source も config です。

実際に公開済みを rebase したら rewrotePublished:true と対象名付き published_rewritten warning（“updating the existing remote branch may require a force push”）を返します。remote ブランチや upstream は変えません。個人方針はユーザー設定で、repo .mabo.toml には置けません。

```sh
mabo config set sync.strategy rebase
mabo config set sync.rewrite-published true
mabo config list --sources
mabo config unset sync.rewrite-published
```

rebase は upstream の cherry-pick（revert 済みを含む）、意図的な空コミット、統合で空になるコミットを保持します。Git 2.29 以上、merge を平坦化できるかの検証には 2.38 以上が必要です。固有変更・競合解決のある merge や自動 merge tree を検証できないものは、変更せず --merge を案内します。dirty（非 ignored の未追跡を含む）、detached、統合済みはスキップ。統合で上書きされ得る ignored パスも core.ignorecase を考慮して dirty スキップします。linked checkout の default branch も戦略・許可によらず ff-only で、ローカル分岐を保ちます。fetch 失敗はその remote の item に影響し、他の base は続行できます。

競合はファイルを列挙し HEAD/index/内容を復元（5）。--keep-conflicts は workspace の統合対象がちょうどひとつ必要で、任意の primary 更新は ff-only のままです。先に他 item が変わった後の失敗・競合・公開拒否は 6 が優先。変化なしなら運用失敗 1、競合 5、公開拒否 4、スキップ 0。primary 単独の dirty/diverged は 1。使用方法エラーは 2。所有者・内部ロック・使用中検出はありません。

人間向けは対象ごとに `<name>  <status>  [detail]` と件数。JSON schema 2 の data は `{plan,items:[…],main:item|null}` です。item は workspace/status/strategy/strategySource/rewriteAllowed/rewriteSource/rewrotePublished/before/after/conflicts/detail/code（published など）。workspace は統合前の観測、before/after は完全 SHA です。診断用 name/path/branch/base も返します。strategy は rebase/merge/ff-only または選択前スキップの null、不明値も null です。

状態は updated、up-to-date、dirty、diverged、integrated、detached、base-gone、base-unknown、conflict、refused、failed、primary の not-default-branch です。

孤立レコードは Git 登録もディレクトリもありません。list は [orphaned]、JSON は orphaned:true、branch/head:null（既存は orphaned:false）。path/exec は拒否し、show は確認できます。remove はフック・ブランチ削除なしで stale record だけを消し、0 と既に消えている旨を返します。JSON は workspace.orphaned:true、branchDeleted:false。同名の生きた対象が優先され、孤立記録の複数一致は ambiguous。孤立記録は名前を予約せず、同名の生きた対象を作れます。残った孤立記録は gc --apply で片付けます（remove の名前は生きた方へ解決します）。

### コマンド別の JSON

`list --json`:

```json
{
  "schema": 2,
  "command": "list",
  "ok": true,
  "data": {
    "workspaces": []
  },
  "warnings": [],
  "error": null
}
```

show/create/adopt は共通オブジェクトを使います。`show --json`:

```json
{
  "schema": 2,
  "command": "show",
  "ok": true,
  "data": {
    "workspace": {}
  },
  "warnings": [],
  "error": null
}
```

`create --json`:

```json
{
  "schema": 2,
  "command": "create",
  "ok": true,
  "data": {
    "workspace": {},
    "source": {"kind": "new", "base": "refs/remotes/origin/main", "reused": false},
    "setup": {"state": "ok", "at": "2026-10-21T09:00:00Z", "ran": false, "ok": true, "command": null, "exitCode": null, "signal": null, "error": null},
    "copy": {"copied": [], "error": null},
    "metadata": {"ok": true, "error": null}
  },
  "warnings": [],
  "error": null
}
```

source.kind は new/branch/pr/issue/detach。正規化した base を含み、branch は branch/ref、PR は number/url/headRef/headRepository/branch/checkout（作成時 branch または pullHead）、issue は number/url/issue を追加します。別 source に付けた issue はリンクです。reused は checkout 作成も setup もしなかったことを表します。

copy.copied は今回コピーした相対パスです。コピー失敗でも workspace は残ります。setup.ran はフック未実行なら false、成功した hook は exitCode:0。失敗は command/exitCode/signal/起動エラーを返します。作成後の記録・コピー・フック失敗は 6 で data に workspace を保ちます。

adopt は `{workspace:{...}}`。保存後の再確認失敗は 6 partial で保存した登録情報を data.workspace に保持します。forget は `{items:[{workspace:{...},ok:true}]}` で記録削除後の状態を返します。

片付ける対象は明示します。

```sh
mabo remove SEL... [--keep-branch] [--delete-unpreserved-branch] [--discard-changes] [--no-hooks] [--source-checkout PATH] [--dry-run]
mabo remove .
mabo gc [--merged] [--closed-pr] [--orphaned] [--older-than D] [--apply] [--keep-branch] [--no-hooks]
```

remove は信頼済み pre-remove 後に checkout を削除し、フック後にも対象を再確認します。保存の根拠は base への統合（通常 merge、完全 tree-entry 遷移で証明した squash/rebase）か、tip と自身の upstream の完全一致です。base 未記録なら repo default。ローカルの証拠に使う base/upstream は common directory の独立 ref に解決する必要があり、独自 fetch 名前空間も使えます。自分のブランチの symbolic alias、detached HEAD、裸の commit ID は根拠になりません。証明できれば削除、それ以外は branch_kept_unpreserved warning と branchKeptReason:unpreserved で保持します。keep-branch は必ず保持、delete-unpreserved-branch は未保存履歴の削除を許可します。

ローカルの保存判定で証明できなかった場合、remove と gc は名前付きブランチについて GitHub の証拠も確認します。記録済み PR（`set --pr` / `create --pr`）が `MERGED` で、`headRefOid` がローカル tip と一致するか、ローカル tip がその祖先なら保存済みです。祖先判定は PR コミットが既にローカルにある場合だけで、fetch はしません。partial clone（`extensions.partialClone` 設定あり、またはいずれかの remote が `promisor=true`）では Git のバージョンにかかわらず tip の完全一致だけを使い、PR オブジェクトの存在確認と祖先判定を行いません。記録 URL を `gh` に渡し、`gh repo view` が checkout から解決した repo との一致を確認します。番号だけならその repo を使います。未リンクなら `gh pr list --head BRANCH --state merged --limit 2` を1回実行し、結果がちょうど1件、head 名と tip ID が完全一致する場合だけ認め、祖先判定はしません。repo の解決はコマンドごとに1回です。gh なし・未認証・失敗・不正 JSON・曖昧な同一性・タイムアウトは従来のローカル判定を維持します。各 gh 呼び出しは10秒制限（正の `MABO_GH_TIMEOUT_MS` で短縮可）で認証プロンプトを無効化し、非対話時の stdin は `/dev/null`。失敗も含むリモート応答をコマンド内でキャッシュし、フック後もローカル tip と祖先関係を再確認します。JSON item に `preservationReason` を追加し、GitHub の証拠は `merged_pr`、remove のローカル証拠は `local`、それ以外は null または省略です。テキスト詳細も merged PR の証拠を示します。計画にも同じ規則が適用されます。既知の制限: repo の同一性はポートなしの `https://HOST/OWNER/REPO` で比較するため、HTTP やデフォルト以外のポートで提供される GitHub Enterprise では merged PR の証拠が成立せず、ブランチは保持されます（確認後に `git branch -d`）。

変更・ステージ済み追跡ファイル（submodule を含む）や非 ignored の未追跡は --discard-changes が必要（なければ 4 dirty）。未保存の detached コミットは --delete-unpreserved-branch が必要（4 unpreserved）。権限は独立です。primary は常に 4 primary。dry-run はフックも変更もなく、plan:true、removed:false、wouldRemove/wouldDeleteBranch を返します。

remove（`--dry-run` も）と gc（計画・apply）は list/show と同じ dirty 判定です。ignored は dirty でなく、警告や discard 権限なしで checkout と一緒に消します。既知の制限: ignored ディレクトリ内の入れ子 Git repo（ignored vendor/ 内の vendor/x/.git など）も消えます。

clean でも populated submodule や残った submodule data は remove の事前検証で 4 dirty（dry-run も）、gc の計画・apply でスキップし `mabo remove NAME --discard-changes` を案内します。許可前に未 push コミットを含め内容を確認してください。

`remove --json` の schema 2 data:

```json
{
  "items": [{
    "workspace": {},
    "removed": true,
    "branchDeleted": true,
    "branchKeptReason": null,
    "preservationReason": "local",
    "alreadyGone": false,
    "error": null
  }]
}
```

item エラーは `{code,message}`。記録も Git 登録もないセレクタは dry-run でも 3 not_found です。全件を先に検証し、ひとつでも不明なら全フック・削除を止め、テキストは不明対象をすべて表示します。名前、dot、pr:N、issue:N、URL、絶対パス、./ または ../ のパスが使えます。

alreadyGone:true には記録または対象として適格な Git 登録が必要です。ディレクトリがなく記録・保存先内 Git 登録の片方か両方があれば 0 で stale 記録/登録だけを消し、フックもブランチ削除もしません。記録とファイルがあり Git 登録だけなければ alreadyGone:true で認めつつ、ファイル・記録・ブランチは残します。ブランチ単独や記録のない未登録ディレクトリは不十分です。

checkout 削除後にブランチ削除だけ失敗すると、branch_kept_delete_failed warning、branchKeptReason:delete_failed、item.detail の Git エラーを返してブランチを残します。item は失敗せず後続も続き、これだけなら 0 で再試行コマンドなし。後のブランチ整理は Git で判断します。

永続的削除後の失敗は 6 で全 item 結果を残します。完了分はレコードも消えるので元のコマンドは 3 になる場合があります。原因を直して error.details.retryCommand（テキストの Retry with）を使います。`cd <primary> && mabo -R <primary> remove [flags] -- <unfinished paths>` の1呼び出しで、未完了だけ、権限と出力モード、-- による保護を保ちます。bash/zsh 用の引用で制御文字は ANSI-C。記録の再削除は記録済みだけで、削除前の絶対パス表記を使います。位置セレクタも事前に確定します。pre-remove の供給元 linked checkout は最後に消し、再試行は同 repo の --source-checkout PATH で元設定を保ちます。それが消えた後は記録整理だけで no-hooks。元が no-hooks または供給元に pre-remove がなければ no-hooks を付け、primary のフックを新たに有効化しません。-R PRIMARY と dot では Git 登録が消えた記録も解決します。

squash/rebase は完全パス、mode、変更前後の完全 blob/gitlink ID を比較します。base の first-parent にある非 merge コミットを使い、squash は全遷移を1コミットと一致させ、rebase は workspace の全コミットを先祖から tip の順で別々の base コミットに対応させます。同じ証拠は再利用せず、後の編集でも base の履歴は根拠です。side history だけの証拠、検証不能 merge、曖昧な merge base、Git 失敗、内容差はブランチ保持。外部 diff/textconv、Git object 書き込み、merge-tree --write-tree は使いません。

gc の既定は全3条件: 統合済み（--merged、証明済み squash/rebase と merged PR の証拠も）、閉じたまたは merged のリンク PR（--closed-pr）、ディレクトリまたは登録なし（--orphaned）。--older-than D は createdAt で絞り、不明時刻は除外し、年齢だけでは候補にしません。D は正の整数と m/h/d/w。merged PR の証拠がなければ作成コミットのままでは merged ではなく、古い・未記録の reflog 判定も保守的です。

apply なしは plan:true と 0（保護対象も含む）。apply は remove の安全判定に従い dirty/未保存をスキップし、対象別の `mabo remove 'NAME' --discard-changes` または --delete-unpreserved-branch を案内します。権限はまとめません。ヒントは repo を固定し、セレクタの一意性を確認します。cd/dot は既存ディレクトリだけで、消えた場合は記録したリンク、なければ `git -C REPO worktree remove --force -- PATH` でその Git 登録と HEAD reflog だけを消す例です。残る記録は後の orphan gc で整理できます。orphan はファイル・ブランチを残して記録/登録を片付けます。gh なし・PR 状態取得不可は unavailable。フック後に再確認し、失敗は永続的削除後なら 6、それ以外は 1 です。

```json
{
  "plan": true,
  "items": [{
    "workspace": {},
    "reasons": ["merged"],
    "action": "wouldRemove",
    "preservationReason": null,
    "detail": null
  }]
}
```

action は wouldRemove/removed/skipped/failed。gc --apply は再実行でき、片付け済みは候補から消えます。

single-branch など狭い refspec の clone では create --pr が branch.<b>.remote/merge を書き git pull を可能にしますが、remote.origin.fetch は変えないため @{upstream} と ahead/behind は解決できません。

### Repo list

```json
{
  "schema": 2,
  "command": "repo list",
  "ok": true,
  "data": {
    "repos": [
      {
        "source": "registry",
        "id": "proj_550e8400-e29b-41d4-a716-446655440000",
        "name": "phantom",
        "canonicalName": "github.com/phantompane/phantom",
        "rootPath": "/home/user/ghq/github.com/phantompane/phantom",
        "createdAt": "2026-01-01T00:00:00.000Z"
      },
      {
        "source": "ghq",
        "name": "repo",
        "canonicalName": "github.com/owner/repo",
        "rootPath": "/home/user/ghq/github.com/owner/repo"
      }
    ]
  },
  "warnings": [],
  "error": null
}
```

repo add --json と repo forget --json の data は `{status,repo}`。エラーは共通 envelope です。

### Clone

clone --json は共通 schema 2 envelope。repo.root は primary の絶対パス、repo.name は小文字 host（port を含む）の正規 host/owner/repo、repo.remoteUrl も同じ小文字 host の URL です。http/https userinfo はユーザー名の token も含め除去します（owner/repo と host/owner/repo は `https://github.com/<owner>/<repo>.git`）。ssh/scp はログイン名を保ちます。cloned は今回作成、updated は --update で既存を fetch したときだけ true。進捗は stderr です。

```json
{
  "schema": 2,
  "command": "clone",
  "ok": true,
  "data": {
    "repo": {
      "root": "/home/user/ghq/github.com/phantompane/phantom",
      "name": "github.com/phantompane/phantom",
      "remoteUrl": "https://github.com/phantompane/phantom.git"
    },
    "cloned": true,
    "updated": false
  },
  "warnings": [],
  "error": null
}
```

clone 失敗は共通エラー envelope。宛先が違う repo、長すぎる名前などファイルシステムが拒否する path component は usage/2。既存 checkout の Git config 読み取り失敗は Git 診断付きで 1。clone/fetch の Git 失敗は command_failed/1。作成・fetch 後の登録失敗は partial/6 で repo.root/cloned/updated を data に保ち、checkout は残り、再試行で登録できます。clone/fetch なしの登録失敗は 1 です。

### ワークスペースの作成・取り込み・記録解除

```sh
mabo create feature --base origin/main
mabo create --branch origin/existing
mabo create --pr 123
mabo create --issue 456 --base main
mabo create snapshot --detach --base main
mabo create feature --base origin/main --reuse
mabo adopt /path/to/linked-checkout --name review --purpose 'review existing work'
mabo forget review pr:123
```

create [NAME] は base から新規ブランチを作り、既定は remote default、次に local default。名前なしなら生成します。同名 local または観測済み remote branch は fetch せず 4 exists_remote、使うには --branch。--branch remote/name は local name を使うか、観測した remote ref を追跡する local を作ります。remote が複数一致なら候補付きで 2。

--pr NUMBER|URL は PR head、fork は owner/branch。fork/削除済み head は pull/N/head を fetch し upstream は設定しません。--issue NUMBER|URL 単独は issues/N と題名の目的を生成し、--pr/--branch と併用ならリンクだけ追加します。NAME は workspace 名を上書きし、既存 branch 名は保ちます。base/branch/pr は排他で、`--detach` は base/issue と併用できます。

既存 workspace は 4 exists。reuse は要求した base/branch/PR と指定 issue が一致すれば、setup 失敗後でもコピー・フックなしで成功します。不一致は 4。作成情報と既存 purpose を保ちます。no-setup はコピー・フックを省略し copy-file と排他。

adopt PATH は選択 repo の既存 linked Git checkout を setup なしで記録します。`--name` / `--base` / `--purpose` / `--pr` / `--issue` を受け取り、base 省略は不明 null。作成時刻と作成コミットも null。記録済みは 4、同 repo の linked checkout でないパスは 3。

forget SEL... は primary の意図も含め記録だけを消します。ファイル・ブランチ・Git 登録は残し、共通セレクタを受け取り全件を先に解決します。
