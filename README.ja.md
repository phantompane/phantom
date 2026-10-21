# Maboroshi

Maboroshi（幻、"phantom space"）— 並列に動くコーディングエージェントのためのワークスペース。

Maboroshi はローカルの Git ワークスペースを管理し、多数のコーディングエージェントと人間が、同じリポジトリで同時に独立して作業できるようにします。ワークスペースは、ひとつのリポジトリのひとつのチェックアウトに、Git が記録しない情報を加えたものです。名前、目的（プルリクエスト、issue、ベース）、観測した状態を扱います。現在、チェックアウトの実体は Git worktree です。

Rust での書き直しは `next` ブランチで開発しており、[GitHub Releases](https://github.com/phantompane/phantom/releases) で `v7.0.0-alpha` 系のプレリリースを配布しています（npm ではまだ配布していません）。従来の TypeScript 版は `main` ブランチに残しています。その README は <https://github.com/phantompane/phantom/blob/main/README.md> にあります。

## なぜ必要か

Git はコードとチェックアウトを記録します。しかし、そのチェックアウトがなぜ存在するのか、片付けてよいのかは記録しません。多くのエージェントが同じリポジトリで同時に作業すると、その答えが分からなくなります。Maboroshi は通常の Git の上で、その情報を補います。リポジトリもブランチも worktree も通常の Git のままで、`mabo` と一緒に `git` を直接使えます。

ワークスペースが分けるのはファイルとブランチであり、プロセス、ポート、データベース、認証情報ではありません。Maboroshi はワークスペースの境界と自身の操作を調整します。サービスを並行して動かすための準備は、プロジェクトとそのフックが担います。

## できること

Maboroshi はワークスペースを作成し、既存の作業を引き継いで準備し、ベースの変更に追従させ、片付けます。

- **確保と準備。** `clone` は ghq のディレクトリ構成でリポジトリを配置します。`create`、`attach`、`github checkout`（別名 `gh checkout`）は、作業ごとに専用のワークスペースを用意し、`.worktreeinclude` で指定した Git の無視対象ファイルをコピーして、信頼済みのリポジトリでプロジェクトフックを実行します。
- **情報の記録。** `set` で目的、関連するプルリクエストや issue、ベースを記録します。`list` と `show` で、何がどこにあるかを確認できます。
- **更新。** `sync` は fetch し、可能ならデフォルトブランチを fast-forward して、選択したワークスペースにベースの変更を取り込みます。
- **片付け。** `gc` はマージ済みブランチ、クローズ済みのプルリクエスト、孤立したレコード、経過時間（`--older-than`）を根拠に対象を選びます。

コマンドは非対話で実行できます。JSON 対応の全コマンドは、成功時もエラー時も schema 2 の共通 envelope を返します。`exec` は子コマンドの出力と終了コードをそのまま返します。人間も同じコマンドを使い、プレーンテキストの出力で操作します。

## デフォルトは安全、違うことをしたいときは明示する

- **マージ済み、クローズ済み、古い、という状態は判断材料であり、削除してよいという許可ではありません。** `gc` は `--apply` または `--force` を指定するまで、削除予定を表示するだけです（`--force` は適用も兼ねます）。`--force` がなければ、未コミットの変更がある作業や、公開済みまたは取り込み済みと確認できないコミットを保護します。デフォルトブランチのワークスペース、実行中のカレントディレクトリがあるワークスペース、Git でロックされたワークスペースは、`--force` があっても保護します。
- **一括操作はすべてのワークスペースが対象です。** `sync --all` はリポジトリ内の全ワークスペースを選び、`--no-default` がなければデフォルトブランチも更新します。対象を絞るには名前を明示してください。`gc` は根拠と経過時間で候補を選び、未コミットの変更や保存されていないコミットの保護は維持します。
- **push 済みの履歴は既定で保ちます。** 変更の取り込みが必要な場合、`sync` は公開済みの作業にベースをマージします。リベースには `--rebase --force` が必要です。ベースに含まれないコミットがひとつでも、既知のリモート追跡参照または fetch 先として設定された参照から到達可能なら、公開済みとして扱います。
- **非対話実行では、mabo 自身がプロンプトで入力を待つことはありません。** `CI` が空でないとき、JSON 出力、`--no-input`、空でも `0` でもない `MABO_NO_INPUT`、標準入力または標準エラー出力が端末でないときが該当します。未信頼のフックを実行する必要がある操作は、変更前に終了コード 4（`untrusted`）で拒否します。`gc` はそのフックが必要な削除をスキップし、スキップ自体はエラーにしません。`mabo trust add` で信頼を記録するか、`--no-hooks` で省略してください。ネットワーク Git 操作には `GIT_TERMINAL_PROMPT=0` を設定し、プロジェクトフックと gh の標準入力には `/dev/null` を渡します。`--exec` と単体 `exec` は標準入力を引き継ぎます。

## 目指さないこと

Maboroshi が担わない役割は次のとおりです。

- エージェントの実行やスケジューリング（起動、監視、割り当て）。
- タスク管理や PR ボット（担当の割り当て、レビュー、コメント、マージ）。
- 日常的な Git 操作の置き換え（コミット、push、履歴編集）。対象はベースの変更を取り込む操作に限ります。
- サンドボックスや実行環境の基盤（コンテナ、依存関係、シークレット、ポート、データベース）。プロジェクトフックを実行するだけです。
- 端末やセッションの管理（tmux、ペイン、ダッシュボード）。提供するのはパスです。
- セキュリティ上の隔離やエージェント間のアクセス制御。

コマンドの使い方・設定・JSON 出力の詳細は [README.md](README.md)（英語）を参照。

## JSON 出力と終了コード

`--json` は `--output json` の別名です。`--output text` は人間向け出力を選びます。`MABO_OUTPUT=text|json` で既定値を設定でき、明示したフラグが優先されます。環境変数を無視するのは `exec` と `--help` によるテキストヘルプだけです。`--version` と `help` は出力モードに従い JSON を返せます。`exec --json` は使用方法エラーになります。

```json
{"schema":2,"command":"list","ok":true,"data":{"workspaces":[]},"warnings":[],"error":null}
```

標準出力には envelope を1件だけ出し、進捗・フック・Git・`--exec` の出力は標準エラー出力へ出します。`data` はコマンド結果を含み、最上位の `schema` は含みません。アプリケーションのバージョンを示す `data.version` を持つのは `--version` だけです。`command` は `github checkout` のような空白区切りの名前です。エラーは `{code,message,details?}`、警告は `{code,message}` です。部分的な結果は `data` に残り、gc の dry-run では `data.plan: true` を返します。パーサーは未知のフィールドを無視してください。

| 終了コード | 意味 | 主な error.code |
| --- | --- | --- |
| 0 | 成功 | error は null |
| 1 | 操作の失敗 | `failed` |
| 2 | 使用方法・曖昧な指定 | `usage`, `ambiguous` |
| 3 | 見つからない・Git リポジトリでない | `not_found`, `branch_not_found`, `not_repository` |
| 4 | 安全判定による拒否 | `dirty`, `unpreserved`, `published`, `exists`, `exists_remote`, `untrusted` |
| 5 | sync の競合 | `conflict` |
| 6 | 永続的な変更後の部分失敗 | `partial` |

コマンドが不明な場合や共通オプションの後にコマンドがない場合も、JSON 出力が選択されていれば使用方法エラーの envelope（終了コード 2）を返します。`sync` はいずれかの対象を更新した後に失敗・競合・公開済み履歴の拒否が起きると、終了コード 6 を優先します。変更がなければ、それぞれ 1・5・4 です。`gc` は checkout や Git 登録の削除後にメタデータ削除が失敗した場合も終了コード 6 を返します。

単体 `exec` は子プロセスの終了コードをそのまま返します。`create --exec` の失敗は 6 となり、子の終了コードは `data.exec.exitCode` に入ります。

## メタデータの保存と移行

ワークスペースのメタデータは `<git-common-dir>/maboroshi/workspaces/<id>.json` に1件ずつ保存します。`id` は `ws_<uuid v4>`、各ファイルには `schema: 2`、`id`、`path`、任意の `name` と、既存の `base`、`purpose`、`createdAt`、`updatedAt`、`createdFrom`、`links` が入ります。JSON 出力の ワークスペースオブジェクトにも `id` が入り、未記録なら null です。検索・置き換え・削除は従来どおり path で行い、削除はそのファイルだけを消します。破損したレコードは警告と null メタデータになり、ほかのレコードは読み続けられます。変更するコマンドは破損があれば拒否して元のファイルを保ちます。`sync` も fetch や対象の更新前にメタデータを厳密に検証します。同じ path の初回同時登録で重複ができた場合は、`createdAt` が古いレコード、同時刻なら `id` の辞書順で小さいレコードに読み取り時にまとめます。全フィールドはそのレコードを採用し、次のメタデータ書き込みで余分なファイルを削除します。`delete` と `gc` はこのメタデータに記録されていれば、設定した保存先の外にあるワークスペース も削除対象にできます。

リポジトリの登録情報は `$XDG_STATE_HOME/maboroshi/repos/<id>.json`（既定は `~/.local/state/maboroshi/repos/<id>.json`）に1件ずつ保存し、既存の `proj_<uuid>` ID を引き継ぎます。同じ root の重複は、読み込み時に `createdAt` が古い方へまとめます。同時刻なら ID の辞書順で決めます。

旧 `maboroshi/worktrees.json` と `$XDG_STATE_HOME/maboroshi/projects.json` は読み取り専用コマンドでも読めます。最初の書き込みで全件を個別ファイルへ移し、旧ファイルを `*.json.imported` に改名します。移行に失敗した場合は旧ファイルを保ちます。mabo 内部のファイルロックはありません。各レコードと、単一ファイルの `trust.toml`・ユーザー設定 `config.toml` は、同じディレクトリの一時ファイルへの書き込み、fsync、rename でアトミックに置き換えます。別レコードの同時追加は両方残り、同じレコードの同時更新は後勝ちです。

## ワークスペースのパスと環境変数

新規ワークスペースの既定パスは `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash8>/<name>` です。`XDG_DATA_HOME` が未設定・空・相対パスの場合は `~/.local/share/maboroshi/workspaces/...` を使います。`workspace-root` 設定は引き続き使えます。既存の `maboroshi/worktrees/` 以下は移動せず、`list`、`show`、`delete`、`sync`、`gc` で引き続き扱えます。

フック（`post-create`、`pre-delete`）、`exec`、`create`/`attach --exec` には、`MABO=1`、名前の `MABO_WORKSPACE`、記録済み ID の `MABO_WORKSPACE_ID`（未記録なら空）、絶対パスの `MABO_WORKSPACE_PATH`、primary checkout の絶対パスの `MABO_REPO_PATH` を渡します。フック設定を読む場所は実行元チェックアウトのままです。旧 `MABO_NAME`、`MABO_PATH`、`MABO_ROOT_PATH` は子プロセスから取り除くため、スクリプトを更新してください。

JSON の結果キーは `workspace` / `workspaces` です。共有オブジェクトの `default` 真偽値は `kind` に変わり、primary checkout は `primary`、ほかは `workspace` です。schema 2、終了コード、旧メタデータの移行方法は変わりません。


## リポジトリ・設定・信頼・ヘルプのコマンド

コマンドの前、またはオプションの間に `-R/--repo REF` を指定すると、対象のリポジトリを選べます。旧インターフェースの `-p/--project`、`project`、`preferences`、`untrust`、`version`、`trust --yes/--list` は、移行先のヒントを出して終了コード 2 を返します。

```sh
mabo repo add [PATH]
mabo repo list [--registered | --discovered] [--names | --paths]
mabo repo show [REF]
mabo repo forget REF
mabo config get KEY [--sources]
mabo config set KEY VALUE
mabo config unset KEY
mabo config list [--sources]
mabo trust add [REPO]
mabo trust remove [REPO]
mabo trust list
mabo help [COMMAND...] [--json]
mabo --version --json
```

`repo forget` は登録情報だけを削除します。`repo show` は primary checkout、既定ブランチ、`.mabo.toml` の有無、信頼状態、ワークスペースの保存先を表示します。登録済みリポジトリは検出結果より優先され、`--discovered` は検出した未登録のルートだけを一覧表示します。`trust add` はフックを表示し、確認を求めずに信頼を記録します。作成時に人間向けの端末で信頼を確認する挙動は変わりません。非対話モードで未信頼のフックを実行しようとすると、終了コード 4 を返します。

ユーザー設定のキーは `workspace-root`（絶対パス、`~/`、またはリポジトリルートからの相対パス）、`clone-root`、`discover-ghq`、`keep-branch` です。旧キーの `worktrees-directory`、`root`、`ghq-discovery` は `config_key_renamed` の警告を出して読み込みます。新しい名前の値が優先され、次に設定の書き込みが成功した際に旧キーを新しい名前へ書き換えます。`directory-name-separator` は `config_key_removed` の警告を出して無視し、書き込み時に削除します。`--sources` は各設定の有効な値、取得元、詳細を含みます。`clone-root` の既定値は従来どおり ghq.root → GHQ_ROOT → ~/ghq の順で決まります。

JSON は schema 2 の envelope を使います。リポジトリの結果キーは `repo` / `repos` で、clone は `data: {repo: {root, name, remoteUrl}, cloned, updated}` を返します。`help --json` は help-data.json の仕様全体を含み、すべてのコマンドとフラグ、終了コードとエラーコード、`schemaVersion: 2` を返します。`--version --json` はアプリケーションのバージョンを `data.version` に入れます。詳しい例は英語の README を参照してください。

ワークスペースの所有者（owner）と `lastUsedAt` は廃止しました。`--owner` は終了コード 2 で、`--purpose`・PR リンク・ワークスペース名を使うよう案内します。`sync --mine` は終了コード 2 で、名前の明示か `--all` を案内します。`MABO_AGENT_ID` は使われなくなりました。古いレコードはそのまま読め、次にメタデータを書き込むときにこれらのフィールドは削除されます。`show`・`path`・`list`・`exec` はレコードを変更しません。`gc --older-than` は `createdAt` を使います。

## ワークスペースの選択・確認・更新

`SEL` には名前、`.`（現在のディレクトリを含むチェックアウト）、`pr:N`、`issue:N`、PR/issue の URL を指定できます。PR/issue は記録済みのリンクだけを検索し、新規作成しません。該当なしは終了コード 3（`not_found`）、複数一致は 2（`ambiguous`）です。`.` と別リポジトリの `-R` の併用は 2、リポジトリ外での現在位置の選択は 3 になります。

`show [SEL]`・`path [SEL]`・`set [SEL]`・`exec [SEL] -- COMMAND [ARG...]` は SEL 省略時に `.` を選びます。primary 内では primary checkout が対象です。`show` は primary や管理外の未記録チェックアウトを `managed:false` として表示します。`sync` と `delete` の位置引数にも同じセレクタを使えます。引数なしの `sync` の対象と `delete` のフラグ・安全判定は従来どおりです。

```sh
mabo show pr:774 --json
cd "$(mabo path feature/auth)"
mabo set --purpose 'fix checkout' --base origin/main --pr 774
mabo set feature/auth --unset purpose base pr issue
mabo exec -- git status
mabo exec feature/auth -- npm test
mabo list --kind workspace --paths
mabo list --all-repos --json
```

`path` のテキスト出力は絶対パスと改行だけ、JSON は `data: {path}` です。`show` と `set` は `data.workspace` を返します。共有オブジェクトには `id`、`name`、`kind`、`path`、`current`、`repo:{root,name}`、`managed`、`orphaned`、`branch`、`head`、`detached`、`dirty`、`base`、`createdFrom`、`upstream`、`purpose`、`links`、`createdAt`、`updatedAt` が入り、不明な値は null です。`upstream` は未設定なら null、設定時は `{ref,ahead,behind,gone}` です。削除済みなら `gone:true`、件数は null になります。

`show`・`path`・`list`・`exec` は記録の内容・mtime を変えず、旧ファイルの移行もしません。`set` は指定フィールドだけを一度の atomic write で更新します。`--unset` は purpose/base/pr/issue を削除し、複数フィールドやフラグの繰り返しを受け付けます。不正なフィールドや同じフィールドの設定と削除の併用は終了コード 2 です。`--base` は参照を検証して full ref 化し、コミット指定も引き続き使えます。`--unset base` は既定値を補わず、不明として記録します。

`list --kind workspace|primary` は種類を絞り、`--names` と `--paths` は1行1件のテキストを出します。`--all-repos` は `repo list` が把握する登録済み・検出済みリポジトリを一覧にし、JSON には `data.repos` と全ワークスペースの `data.workspaces` が入ります。`-R` とは併用できません。人間向け出力にはリポジトリ見出し、現在位置の `*`、名前、ブランチ、upstream の進み・遅れ（`↑a ↓b`）、dirty、PR/issue、目的を表示し、削除済み upstream は `upstream:gone` と表示します。

旧 `where` は `path` / `show --json`、旧 `meta` / `meta set` は `set` / `show`、`list --no-default` は `--kind workspace` を案内して終了コード 2 を返します。`exec` では子コマンドの前の `--` が必須です。省略時は新構文のヒントと終了コード 2 を返します。`exec` は `MABO_OUTPUT` を無視し、明示的な JSON 出力は拒否します。使用方法エラーと付随するヘルプは標準エラー出力へ出し、テキストの標準出力は空にします。
