# mabo

mabo (Maboroshi, 幻) — コーディングエージェントの並列作業用の独立した Git ワークスペース。

> [!WARNING]
> mabo は開発中です（v7 アルファ版）。7.0.0 までは、コマンド・出力・設定・保存形式が後方互換なしに変わることがあります。まだ本番環境での利用はおすすめしません。

タスクごとに独立した Git ワークスペース（リンクされた worktree）を用意し、複数のエージェントと人間が同じリポジトリで並行して作業できます。mabo はチェックアウトの目的を記録し、機械可読の出力を提供し、削除前に履歴の保全を確認します。未保全のコミットや未コミットの変更を破棄するには、明示的な許可が必要です。

[English](README.md) · [コマンドリファレンス](docs/commands.md) · [JSON 仕様](docs/json.md)（詳細ドキュメントは英語）

## インストール

インストーラーとバイナリを同じリリースに固定します。SHA-256 と GitHub アーティファクトのアテステーションを検証します。アテステーションの検証には `gh` が必要です。インストーラーには `curl` と `tar` も必要です。

```sh
curl -fsSL https://github.com/phantompane/phantom/releases/download/v7.0.0-alpha.9/install.sh \
  | MABO_VERSION=v7.0.0-alpha.9 sh -s -- --prerelease --verify-attestation
```

Linux・macOS の x64/arm64 に対応しています。WSL では Linux バイナリを使ってください。sudo やシェル設定の変更なしで `~/.local/bin` にインストールします。`--prerelease` はバージョン未固定時のプレリリース選択を許可します。バージョン固定時は指定したプレリリースをそのまま使えます。

ソースからのビルドには Rust 1.89 以降が必要です。`<TAG>` を `v7.0.0-alpha.9` などのリリースタグに置き換えてください。

```sh
cargo install --git https://github.com/phantompane/phantom --tag <TAG> --locked mabo
```

npm の `@phantompane/cli` と Homebrew の `phantom` は旧 TypeScript 版 v6 です。

オプション、手動インストール、更新方法は[インストールの詳細](docs/installation.md)を参照してください。

## クイックスタート

既存の clone と `main` ブランチを使います。必要に応じてベースブランチを置き換えてください。`sync` には対象リモートへのアクセスが必要です。この例ではコードを変更しないため、保全済みのタスクブランチを削除できます。フックのあるリポジトリでは[信頼の付与または明示的なスキップ](docs/hooks.md)が必要です。

```sh
cd your-repo
mabo create task/auth --base main --purpose 'implement authentication'
mabo exec task/auth -- git status --short
mabo list
mabo sync task/auth
mabo remove task/auth --dry-run
mabo remove task/auth
```

`exec` はシェルの現在地を変えずにワークスペースで実行します。自分で移動する場合は、削除前に `cd "$(mabo path task/auth)"` を使うか、任意の[シェル関数と補完](docs/shell.md)を読み込んで `mabo cd task/auth` を使ってください。

## 基本概念

- **ワークスペース:** タスクのチェックアウトと、目的・ベース・PR/issue リンクなどのメタデータです。名前に `/` を使えます。名前、`.`、パス、`pr:N`、`issue:N`、記録済みの PR/issue URL で選択します。
- **プライマリチェックアウト:** リポジトリの元のチェックアウトで、ファイルのコピー元です。mabo はこれを削除しません。デフォルトブランチ上なら `sync --main` で明示的に更新できます。
- **記録と管理:** 記録は Git 共通ディレクトリに保存します。未記録のチェックアウトも表示されます。`adopt` は既存のリンクされたチェックアウトを記録し、`forget` は記録だけを削除します。設定されたワークスペースディレクトリの外にある未記録のチェックアウトは管理対象外で、削除から保護されます。
- **履歴の保全:** ブランチは保全を証明できる場合に削除し、証明できない場合は警告とともに残します。未コミットの変更の破棄には `--discard-changes`、未保全の履歴の削除には `--delete-unpreserved-branch` が必要です。無視ファイルはワークスペースと一緒に削除され、無視ディレクトリ内の入れ子のリポジトリも含みます。`gc` は `--apply` まで計画だけを表示し、安全に削除できない対象をスキップします。

自動化の前に[削除の安全性と再試行](docs/safety.md)、[同期戦略](docs/sync.md)を確認してください。所有者管理、内部ロック、使用中かどうかの検出はないため、他のエージェントと調整してください。

## コマンド

| コマンド | 用途 |
|---|---|
| `mabo create` | 新規・既存ブランチ、PR、issue、切り離したコミットから作成 |
| `mabo adopt` | 既存のリンクされたチェックアウトを記録 |
| `mabo list` | ワークスペースとプライマリチェックアウトの一覧 |
| `mabo show` | 目的と現在の状態を確認 |
| `mabo path` | ワークスペースの絶対パスを出力 |
| `mabo set` | 目的、ベース、PR・issue のリンクを更新 |
| `mabo setup` | 無視ファイルをコピーし、信頼済みのセットアップフックを再実行 |
| `mabo exec` | ワークスペースでコマンドを実行（`--` が必須） |
| `mabo sync` | fetch してベースを取り込む。`--main` でプライマリも更新 |
| `mabo remove` | 指定したワークスペースを安全性を確認して削除 |
| `mabo forget` | ファイルとブランチを残して記録だけを削除 |
| `mabo gc` | クリーンアップを計画し、`--apply` で実行 |
| `mabo clone` | ghq 互換の配置に clone して登録 |
| `mabo repo` | リポジトリ登録の操作 |
| `mabo repo add` | リポジトリを登録 |
| `mabo repo list` | 登録済み・検出されたリポジトリの一覧 |
| `mabo repo show` | リポジトリを確認 |
| `mabo repo forget` | 登録だけを削除 |
| `mabo trust` | フックの信頼設定 |
| `mabo trust add` | フックを表示し、確認プロンプトなしで信頼を付与 |
| `mabo trust remove` | 信頼を取り消す |
| `mabo trust list` | 信頼済みの Git 共通ディレクトリの一覧 |
| `mabo config` | ユーザー設定の操作 |
| `mabo config get` | 有効な設定値を取得 |
| `mabo config set` | 設定値を保存 |
| `mabo config unset` | 設定の上書きを解除 |
| `mabo config list` | 有効な設定値の一覧（`--sources` で設定元を表示） |
| `mabo help` | テキストヘルプ、または完全な JSON コマンド仕様 |
| `mabo completions` | bash・zsh・fish の補完スクリプトを生成 |
| `mabo shell-init` | `mabo cd` 用のシェル関数を生成 |
| `mabo --version` | アプリのバージョンを表示（`-v` も利用可） |

グローバルオプションは `-R/--repo REF`、`--json`、`--output text|json`、`--no-input`、`-h/--help`、`-v/--version` です。`exec` では mabo のオプションをセレクターの前に、子コマンドを `--` の後に置きます。[全オプションとワークフロー](docs/commands.md)を参照してください。

## エージェント向け

`--json` または `--output json` で、`schema`、`command`、`ok`、`data`、`warnings`、`error` を持つ schema 2 のエンベロープを 1 つ出力します。失敗時も `data` に部分的な結果が入ることがあるため解析し、未知のフィールドは無視してください。`mabo help --json` でコマンド、フラグ、エラー・警告コードを取得できます。

`--no-input` は mabo の確認プロンプトを無効にします。JSON 出力、空でない `CI`、空でも `0` でもない `MABO_NO_INPUT`、標準入力または標準エラーが端末でない場合も同様です。未信頼のフックは変更前に拒否され、`gc` はその対象をスキップします。単独の `exec` は子コマンドの出力と終了ステータスを保持します。`exec`、`completions`、`shell-init` は明示的な JSON 指定を拒否します。

| 終了コード | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 実行上の失敗 |
| 2 | 使用方法の誤り、または曖昧なセレクター |
| 3 | 対象またはリポジトリが見つからない |
| 4 | 安全上の拒否 |
| 5 | 同期の競合 |
| 6 | 永続的な変更後の部分的な完了 |

[JSON オブジェクトとコマンド別データ](docs/json.md)、[終了コードと復旧](docs/exit-codes.md)を参照してください。

## 設定

`mabo config` で `workspace-root`、`clone-root`、`discover-ghq`、`sync.strategy`、`sync.rewrite-published` を管理します。`-R/--repo REF` はパス、登録済みの名前、検出された名前でリポジトリを選びます。[設定・パス・リポジトリ登録](docs/configuration.md)を参照してください。

## フックと信頼

リポジトリの `.mabo.toml` に setup・pre-remove フックを定義します。`.worktreeinclude` はプライマリからコピーする無視ファイルを選びます。`mabo trust add` で信頼を付与する前にフックを確認してください。信頼は Git 共通ディレクトリのパスに付与され、同じパスに clone し直しても取り消すまで有効です。[フック・信頼・セットアップの再試行](docs/hooks.md)を参照してください。

## FAQ

**普通の `git worktree` との違いは？** Git がリンクされたチェックアウトを提供し、mabo はタスクのメタデータ、リポジトリ検出、準備、ベースとの同期、根拠に基づくクリーンアップを追加します。ブランチと worktree は通常の Git のままです。

**エージェントの実行やサービスの分離も行う？** ワークスペースが分けるのはファイルとブランチです。mabo はエージェントのスケジュール、端末セッションの管理、プロセス・ポート・データベース・認証情報・エージェント間アクセスの分離は行いません。

## ステータス

アルファ版です（上の注意を参照）。破壊的変更は [CHANGELOG](CHANGELOG.md) に記載しています。

## コントリビューション

開発手順とチェックは [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。プルリクエストの宛先は `main` です。

## ライセンス

[MIT](LICENSE)。
