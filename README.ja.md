# Maboroshi

Maboroshi（幻、"phantom space"）— 並列に動くコーディングエージェントのためのワークスペース。

Maboroshi はローカルの Git ワークスペースを管理し、多数のコーディングエージェントと人間が、同じリポジトリで同時に独立して作業できるようにします。ワークスペースは、ひとつのリポジトリのひとつのチェックアウトに、Git が記録しない情報を加えたものです。名前、目的（プルリクエスト、issue、ベース）、観測した状態を扱います。現在、チェックアウトの実体は Git worktree です。

Rust での書き直しは `next` ブランチで開発しており、[GitHub Releases](https://github.com/phantompane/phantom/releases) で `v7.0.0-alpha` 系のプレリリースを配布しています（npm ではまだ配布していません）。従来の TypeScript 版は `main` ブランチに残しています。その README は <https://github.com/phantompane/phantom/blob/main/README.md> にあります。

## なぜ必要か

Git はコードとチェックアウトを記録します。しかし、そのチェックアウトがなぜ存在するのか、片付けてよいのかは記録しません。多くのエージェントが同じリポジトリで同時に作業すると、その答えが分からなくなります。Maboroshi は通常の Git の上で、その情報を補います。リポジトリもブランチも worktree も通常の Git のままで、`mabo` と一緒に `git` を直接使えます。

ワークスペースが分けるのはファイルとブランチであり、プロセス、ポート、データベース、認証情報ではありません。Maboroshi はワークスペースの境界と自身の操作を調整します。サービスを並行して動かすための準備は、プロジェクトとそのフックが担います。

## できること

Maboroshi はワークスペースを作成し、既存の作業を引き継いで準備し、ベースの変更に追従させ、片付けます。

- **確保と準備。** `clone` は ghq のディレクトリ構成でリポジトリを配置します。`create`は、作業ごとに専用のワークスペースを用意し、`.worktreeinclude` で指定した Git の無視対象ファイルをコピーして、信頼済みのリポジトリでプロジェクトフックを実行します。
- **情報の記録。** `set` で目的、関連するプルリクエストや issue、ベースを記録します。`list` と `show` で、何がどこにあるかを確認できます。
- **更新。** `sync` は fetch し、可能ならデフォルトブランチを fast-forward して、選択したワークスペースにベースの変更を取り込みます。
- **片付け。** `gc` はマージ済みブランチ、クローズ済みのプルリクエスト、孤立したレコードを根拠に対象を選び、`--older-than` は作成日時で絞り込みます。

コマンドは非対話で実行できます。JSON 対応の全コマンドは、成功時もエラー時も schema 2 の共通 envelope を返します。`exec` は子コマンドの出力と終了コードをそのまま返します。人間も同じコマンドを使い、プレーンテキストの出力で操作します。

## デフォルトは安全、違うことをしたいときは明示する

- **安全な片付け。** `gc` は `--apply` まで計画だけを表示し、dirty や未保存の候補をスキップします。primary、デフォルトブランチ、カレントワークスペース、Git のロックがあるチェックアウトも保護します。
- **一括操作はすべてのワークスペースが対象です。** `sync --all` はリポジトリ内の全ワークスペースを選びます。primary も進めるには `--main` を付けます。対象を絞るには名前を明示してください。`gc` は根拠と経過時間で候補を選び、未コミットの変更や保存されていないコミットの保護は維持します。
- **push 済みの履歴は既定で保ちます。** 変更の取り込みが必要な場合、`sync` は公開済みの作業にベースをマージします。ベースに含まれないコミットがひとつでも、既知のリモート追跡参照または fetch 先として設定された参照から到達可能なら、公開済みとして扱います。
- **非対話実行では、mabo 自身がプロンプトで入力を待つことはありません。** `CI` が空でないとき、JSON 出力、`--no-input`、空でも `0` でもない `MABO_NO_INPUT`、標準入力または標準エラー出力が端末でないときが該当します。未信頼のフックを実行する必要がある操作は、変更前に終了コード 4（`untrusted`）で拒否します。`gc` はそのフックが必要な削除をスキップし、スキップ自体はエラーにしません。`mabo trust add` で信頼を記録するか、create では `--no-setup`、setup/remove/gc では `--no-hooks` で省略してください。ネットワーク Git 操作には `GIT_TERMINAL_PROMPT=0` を設定し、プロジェクトフックと gh の標準入力には `/dev/null` を渡します。単体 `exec` は標準入力を引き継ぎます。

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

標準出力には envelope を1件だけ出し、進捗・フック・Git の出力は標準エラー出力へ出します。`data` はコマンド結果を含み、最上位の `schema` は含みません。アプリケーションのバージョンを示す `data.version` を持つのは `--version` だけです。`command` は `repo list` のような空白区切りの名前です。エラーは `{code,message,details?}`、警告は `{code,message}` です。部分的な結果は `data` に残り、gc の dry-run では `data.plan: true` を返します。パーサーは未知のフィールドを無視してください。

| 終了コード | 意味 | 主な error.code |
| --- | --- | --- |
| 0 | 成功 | error は null |
| 1 | 操作の失敗 | `failed` |
| 2 | 使用方法・曖昧な指定 | `usage`, `ambiguous` |
| 3 | 見つからない・Git リポジトリでない | `not_found`, `branch_not_found`, `not_repository` |
| 4 | 安全判定による拒否 | `dirty`, `unpreserved`, `published`, `exists`, `exists_remote`, `untrusted`, `primary` |
| 5 | sync の競合 | `conflict` |
| 6 | 永続的な変更後の部分失敗 | `partial` |

コマンドが不明な場合や共通オプションの後にコマンドがない場合も、JSON 出力が選択されていれば使用方法エラーの envelope（終了コード 2）を返します。`sync` はいずれかの対象を更新した後に失敗・競合・公開済み履歴の拒否が起きると、終了コード 6 を優先します。変更がなければ、それぞれ 1・5・4 です。`gc` は checkout や Git 登録の削除後にメタデータ削除が失敗した場合も終了コード 6 を返します。

単体 `exec` は子プロセスの終了コードをそのまま返します。

## メタデータの保存と移行

ワークスペースのメタデータは `<git-common-dir>/maboroshi/workspaces/<id>.json` に1件ずつ保存します。`id` は `ws_<uuid v4>`、各ファイルには `schema: 2`、`id`、`path`、任意の `name` と、既存の `base`、`purpose`、`createdAt`、`updatedAt`、`createdFrom`、`links` が入ります。JSON 出力の ワークスペースオブジェクトにも `id` が入り、未記録なら null です。検索・置き換え・削除は従来どおり path で行い、削除はそのファイルだけを消します。破損したレコードは警告と null メタデータになり、ほかのレコードは読み続けられます。変更するコマンドは破損があれば拒否して元のファイルを保ちます。`sync` も fetch や対象の更新前にメタデータを厳密に検証します。同じ path の初回同時登録で重複ができた場合は、`createdAt` が古いレコード、同時刻なら `id` の辞書順で小さいレコードに読み取り時にまとめます。全フィールドはそのレコードを採用し、次のメタデータ書き込みで余分なファイルを削除します。`remove` と `gc` はこのメタデータに記録されていれば、設定した保存先の外にあるワークスペース も削除対象にできます。

リポジトリの登録情報は `$XDG_STATE_HOME/maboroshi/repos/<id>.json`（既定は `~/.local/state/maboroshi/repos/<id>.json`）に1件ずつ保存し、既存の `proj_<uuid>` ID を引き継ぎます。同じ root の重複は、読み込み時に `createdAt` が古い方へまとめます。同時刻なら ID の辞書順で決めます。

旧 `maboroshi/worktrees.json` と `$XDG_STATE_HOME/maboroshi/projects.json` は読み取り専用コマンドでも読めます。最初の書き込みで全件を個別ファイルへ移し、旧ファイルを `*.json.imported` に改名します。移行に失敗した場合は旧ファイルを保ちます。mabo 内部のファイルロックはありません。各レコードと、単一ファイルの `trust.toml`・ユーザー設定 `config.toml` は、同じディレクトリの一時ファイルへの書き込み、fsync、rename でアトミックに置き換えます。別レコードの同時追加は両方残り、同じレコードの同時更新は後勝ちです。

## ワークスペースのパスと環境変数

新規ワークスペースの既定パスは `$XDG_DATA_HOME/maboroshi/workspaces/<checkout>-<hash8>/<name>` です。`XDG_DATA_HOME` が未設定・空・相対パスの場合は `~/.local/share/maboroshi/workspaces/...` を使います。`workspace-root` 設定は引き続き使えます。既存の `maboroshi/worktrees/` 以下は移動せず、`list`、`show`、`remove`、`sync`、`gc` で引き続き扱えます。

フック（`setup`、`pre-remove`）と `exec` には、`MABO=1`、名前の `MABO_WORKSPACE`、記録済み ID の `MABO_WORKSPACE_ID`（未記録なら空）、絶対パスの `MABO_WORKSPACE_PATH`、primary checkout の絶対パスの `MABO_REPO_PATH` を渡します。フック設定を読む場所は実行元チェックアウトのままです。旧 `MABO_NAME`、`MABO_PATH`、`MABO_ROOT_PATH` は子プロセスから取り除くため、スクリプトを更新してください。

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

ユーザー設定のキーは `workspace-root`（絶対パス、`~/`、またはリポジトリルートからの相対パス）、`clone-root`、`discover-ghq`、`sync.strategy`（auto/rebase/merge）、`sync.rewrite-published`（既定 false）です。旧キーの `worktrees-directory`、`root`、`ghq-discovery` は `config_key_renamed` の警告を出して読み込みます。新しい名前の値が優先され、次に設定の書き込みが成功した際に旧キーを新しい名前へ書き換えます。`directory-name-separator` と `keep-branch` は `config_key_removed` の警告を出して無視し、書き込み時に削除します。`--sources` は各設定の有効な値、取得元、詳細を含みます。`clone-root` の既定値は従来どおり ghq.root → GHQ_ROOT → ~/ghq の順で決まります。

JSON は schema 2 の envelope を使います。リポジトリの結果キーは `repo` / `repos` で、clone は `data: {repo: {root, name, remoteUrl}, cloned, updated}` を返します。`help --json` は help-data.json の仕様全体を含み、すべてのコマンドとフラグ、終了コードとエラーコード、`schemaVersion: 2` を返します。`--version --json` はアプリケーションのバージョンを `data.version` に入れます。詳しい例は英語の README を参照してください。

ワークスペースの所有者（owner）と `lastUsedAt` は廃止しました。`--owner` は終了コード 2 で、`--purpose`・PR リンク・ワークスペース名を使うよう案内します。`sync --mine` は終了コード 2 で、名前の明示か `--all` を案内します。`MABO_AGENT_ID` は使われなくなりました。古いレコードはそのまま読め、次にメタデータを書き込むときにこれらのフィールドは削除されます。`show`・`path`・`list`・`exec` はレコードを変更しません。`gc --older-than` は `createdAt` を使います。

## ワークスペースの選択・確認・更新

`SEL` には名前、`.`（現在のディレクトリを含むチェックアウト）、`pr:N`、`issue:N`、PR/issue の URL を指定できます。PR/issue は記録済みのリンクだけを検索し、新規作成しません。該当なしは終了コード 3（`not_found`）、複数一致は 2（`ambiguous`）です。`.` と別リポジトリの `-R` の併用は 2、リポジトリ外での現在位置の選択は 3 になります。

`show [SEL]`・`path [SEL]`・`set [SEL]`・`setup [SEL]`・`exec [SEL] -- COMMAND [ARG...]` は SEL 省略時に `.` を選びます。primary 内では primary checkout が対象です。`show` は primary や管理外の未記録チェックアウトを `managed:false` として表示します。`sync` と `remove` の位置引数にも同じセレクタを使えます。引数なしの `sync` は現在のワークスペースだけを対象にします。primary 内では `--main` と同じです。`remove` は明示的なセレクタを必要とします。

```sh
mabo show pr:774 --json
cd "$(mabo path feature/auth)"
mabo set --purpose 'fix checkout' --base origin/main --pr 774
mabo set feature/auth --unset purpose --unset base --unset pr --unset issue
mabo exec -- git status
mabo exec feature/auth -- npm test
mabo list --kind workspace --paths
mabo list --all-repos --json
```

`path` のテキスト出力は絶対パスと改行だけ、JSON は `data: {path}` です。`show` と `set` は `data.workspace` を返します。共有オブジェクトには `id`、`name`、`kind`、`path`、`current`、`repo:{root,name}`、`managed`、`orphaned`、`branch`、`head`、`detached`、`dirty`、`base`、`createdFrom`、`upstream`、`purpose`、`links`、`createdAt`、`updatedAt` が入り、不明な値は null です。`upstream` は未設定なら null、設定時は `{ref,ahead,behind,gone}` です。削除済みなら `gone:true`、件数は null になります。

`show`・`path`・`list`・`exec` は記録の内容・mtime を変えず、旧ファイルの移行もしません。`set` は指定フィールドだけを一度の atomic write で更新します。`--unset FIELD` は1回に purpose/base/pr/issue のいずれか1つを削除し、複数フィールドを削除するにはフラグを繰り返します。不正なフィールドや同じフィールドの設定と削除の併用は終了コード 2 です。`--base` は参照を検証して full ref 化し、コミット指定も引き続き使えます。`--unset base` は既定値を補わず、不明として記録します。`mabo set <name> --base REF` で再設定するまで sync は `base-unknown` でスキップします。base フィールドが無い旧記録には従来どおり既定ベースを使います。

`list --kind workspace|primary` は種類を絞り、`--names` と `--paths` は1行1件のテキストを出します。`--all-repos` は `repo list` が把握する登録済み・検出済みリポジトリを一覧にし、JSON には `data.repos` と全ワークスペースの `data.workspaces` が入ります。`-R` とは併用できません。人間向け出力にはリポジトリ見出し、現在位置の `*`、名前、ブランチ、upstream の進み・遅れ（`↑a ↓b`）、dirty、PR/issue（`#12` / `issue #34`）、目的を表示し、削除済み upstream は `upstream:gone` と表示します。

旧 `where` は `path` / `show --json`、旧 `meta` / `meta set` は `set` / `show`、`list --no-default` は `--kind workspace` を案内して終了コード 2 を返します。`exec` では子コマンドの前の `--` が必須です。省略時は新構文のヒントと終了コード 2 を返します。`exec` は `MABO_OUTPUT` を無視し、明示的な JSON 出力は拒否します。使用方法エラーと付随するヘルプは標準エラー出力へ出し、テキストの標準出力は空にします。

## 作成・取り込み・記録解除

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

`create [NAME]` は新しいブランチを作ります。`--base` の既定はリモートの既定ブランチ、なければローカルの既定ブランチです。NAME 省略時は名前を生成します。ローカルのブランチや観測済みリモート追跡 ref と同じ名前は fetch せずに終了コード 4（`exists_remote`）で拒否します。既存ブランチには `--branch` を使います。`--branch remote/name` はローカルの name を使うか、そのリモートを追跡する name を作ります。複数リモートに一致した場合は終了コード 2 で候補を表示します。

`--pr 番号|URL` は PR の head ブランチを使い、fork では owner/branch を名前にします。fork や head 削除済み PR は pull/N/head から取得し、upstream を設定しません。`--issue 番号|URL` 単独では issues/N を作り、目的の既定値を issue のタイトルにします。`--pr`・`--branch` と一緒ならリンクだけを追加します。明示した NAME はワークスペース名を変更し、既存ブランチの名前は維持します。`--base`・`--branch`・`--pr` は排他的です。`--detach` は `--base`・`--issue` と組み合わせられます。

既存ワークスペースは終了コード 4（`exists`）です。`--reuse` を付けると、要求した base・branch・PR と指定した issue が一致する場合だけ成功し、コピーもフックも再実行しません。不一致は同じく 4 です。繰り返しても作成情報や既存の目的を保持します。create の `--no-setup` はコピーとフックを両方省略し、`--copy-file` とは併用できません。旧 `create --no-hooks` は終了コード 2 で移行方法を案内します。

create の JSON は `data.workspace`、`data.source`、`data.setup`、`data.copy`、`data.metadata` を返します。source.kind は new/branch/pr/issue/detach、base は正規化済み ref、reused は再利用の有無です。branch は branch/ref、PR は number/url/headRef/headRepository/branch/checkout、issue は number/url/issue を含みます。checkout は作成時の branch または pullHead です。copy は copied（コピーした相対パスの配列）と error、setup は state/at/error と ran/ok/command/exitCode/signal を持ちます。作成後のコピー・フック・記録の失敗は部分完了の 6 です。

`adopt PATH` は同一リポジトリの既存 linked worktree を管理下に入れます。`--name`・`--base`・`--purpose`・`--pr`・`--issue` を指定でき、setup は実行せず、createdAt と createdFrom は null です。`--base` は既存チェックアウトの同期先を任意で記録し、省略時は不明（`null`）です。既に記録済みなら 4、対象リポジトリの linked checkout でないパスは 3 です。JSON は workspace を返します。記録保存後にワークスペースの再取得が失敗した場合は 6（`partial`）を返し、保存済みの登録情報を `data.workspace` に残します。

`forget SEL...` は記録だけを消し、チェックアウト・ブランチ・Git 登録を残します。primary の記録も対象にできます。名前・`.`・pr:N・issue:N・PR/issue URL を複数指定でき、全セレクタを解決してから記録を削除します。JSON は `{items:[{workspace,ok}]}` で、workspace は記録削除後の状態を返します。

移行: attach BRANCH は create --branch BRANCH、github/gh checkout は create --pr REF または create --issue REF に変わりました。create -x/--exec は create の後に exec SEL -- COMMAND を実行してください。旧構文は text・JSON ともに終了コード 2 と移行ヒントを返します。

## Setup lifecycle

```sh
mabo setup feature-auth
mabo setup --no-hooks --copy-file '*.env'
mabo create feature-auth --no-setup
```

`setup [SEL]` は省略時に `.` を選び、共通セレクタを使います。`.worktreeinclude` と `--copy-file` に一致する Git の無視対象ファイルを、常に primary checkout からコピーします。サブディレクトリや別ワークスペースで実行してもコピー元は変わりません。既存ファイルは上書きせず、symlink はスキップします。コピー後に `[hooks] setup` を実行し、コピーの失敗時にはフックを実行しません。`setup --no-hooks` はコピーだけを実行します。

`.mabo.toml` は実行元チェックアウトから読みます。フック名は `[hooks] setup` と `pre-remove` です。旧 `post-create` / `pre-delete` キーは終了コード 1（`failed`）となり、新しい名前への変更を案内します。未知キーも拒否します。`remove` と `gc` は `pre-remove` を実行します。

setup の成功は 0、コピーやフックの失敗は 1、対象なしは 3 です。未信頼フックはコピーや記録更新の前に 4（`untrusted`）で拒否します。`mabo trust add` または `MABO_TRUST_ALL=1` で許可できます。primary checkout はコピー元と同じなので 4（`primary`）で拒否します。create の setup 失敗は 6 のままで、`cd '/absolute/source/checkout' && mabo setup 'SELECTOR'` で再試行します。`create --reuse` は setup を再実行しません。setup フックは何度実行してもよいように書いてください。

Run retry hints in bash or zsh. The hint preserves the original hook configuration and every `--copy-file` pattern, using ANSI-C quoting (`$'...'`) for control characters. If no name or PR/issue selector resolves uniquely, it uses `(cd WORKSPACE && mabo setup . --source-checkout SOURCE)`. `--source-checkout` must belong to the same repository.

共有ワークスペース JSON の `setup` は `{state, at, error}` です。新規作成では pending → running → ok / failed と遷移し、`--no-setup` は skipped を記録します。古いレコード・移行済みレコード・adopt は unknown（at/error は null）、未記録や forget 後は setup 自体が null です。成功した再実行で error を消します。人間向け list は ok 以外で `setup:failed` などを表示します。setup の JSON は `data: {workspace, setup, copy}` で、setup には実行したフックの ran/ok/command/exitCode/signal も含みます。

running には内部的に pid とホストを記録します。同じホストでその pid が存在しなければ、表示時だけ interrupted とします。読み取りでレコードは書き換えず、別ホストやホスト不明なら running のままです。この情報はロックや使用中検出ではなく、操作や再実行をブロックしません。同一レコードへの同時書き込みは従来どおり後勝ちです。

## Retirement

```sh
mabo remove SEL... [--keep-branch] [--delete-unpreserved-branch] [--discard-changes] [--no-hooks] [--dry-run]
mabo remove .
mabo gc [--merged] [--closed-pr] [--orphaned] [--older-than D] [--apply] [--keep-branch] [--no-hooks]
```

`remove` は全セレクタと安全条件を確認し、信頼済みの `pre-remove` を実行してからチェックアウトを消します。ブランチは base への merge・squash・rebase (exact tree-entry matching) の取り込み、または自身の upstream との完全一致を確認できれば削除します。base が未記録ならリポジトリの既定 base を確認します。未保存のブランチは `branch_kept_unpreserved` 警告と `branchKeptReason: "unpreserved"` を付けて保持します。`--keep-branch` は常に保持し、`--delete-unpreserved-branch` は未保存でも削除を許可します。

変更済み・未追跡・ignored ファイルは `--discard-changes` がなければ終了コード 4（`dirty`）で保護します。未保存の detached コミットは `--delete-unpreserved-branch` がなければ 4（`unpreserved`）、primary は常に 4（`primary`）です。2つの許可は独立しています。`--dry-run` はフックを実行せず、ファイル・参照・レコードを変更せずに `plan:true` と `removed:false`、`wouldRemove`、`wouldDeleteBranch` を返します。

JSON は schema 2 の envelope を維持し、remove の `data.items` は `{workspace, removed, branchDeleted, branchKeptReason, alreadyGone, error}` です。永続的な削除後の失敗は終了コード 6。全対象の結果を残し、同じコマンドを再実行できます。既に無い対象は成功して `alreadyGone:true` になり、記録も無ければ workspace には指定した名前のみを返します。孤立レコードはフックやブランチ削除なしで消します。

`gc` は指定なしなら `--merged`・`--closed-pr`・`--orphaned` の3条件を使います。`--older-than D` は `createdAt` で絞り込み、日時不明のレコードを除外します。年齢だけでは候補にしません。`--apply` がなければ `plan:true`、終了コード 0。適用時は dirty・未保存の候補をスキップし、対象を絞った `mabo remove 'NAME' --discard-changes` または `mabo remove 'NAME' --delete-unpreserved-branch` のヒントを返します。許可フラグはまとめません。孤立レコード・登録の整理ではブランチと残存ファイルを保持します。gh が無い場合は PR 状態を `unavailable` と報告します。JSON は `{plan, items:[{workspace, reasons, action, detail}]}`、action は `wouldRemove`・`removed`・`skipped`・`failed` です。

旧 `delete` は終了コード 2 で `remove SEL...` を案内し、`--current` は `remove .` に移行します。旧 `-f/--force` は remove の独立した許可か gc の `--apply` を案内します。`gc --pr` は `gc --closed-pr` です。旧 config の `keep-branch` は型にかかわらず警告して無視し、次の設定書き込みで消します。必要なら `--keep-branch` を明示してください。sync の挙動は P8 まで変更しません。

## Sync redesign

```sh
mabo sync [SEL... | --all | --main] [--auto | --rebase | --merge] [--rewrite-published] [--keep-conflicts] [--dry-run]
mabo sync . --main --dry-run --json
mabo sync feature/auth --rebase --rewrite-published
mabo config set sync.strategy rebase
mabo config set sync.rewrite-published true
mabo config list --sources
```

引数なしでは、サブディレクトリを含め現在のワークスペースだけを同期し、primary のブランチは進めません。primary 内では `--main` と同じです。`--main` 単独は primary だけを選び、primary がデフォルトブランチにいる場合だけ fast-forward します。それ以外は `not-default-branch` でスキップします。`sync . --main` は現在のワークスペースと primary を選びます。`--all` は全ワークスペースで、SEL との併用は終了コード 2。primary も含めるには `--main` を追加します。

関係する remote はそれぞれ一度だけ fetch します。`--dry-run` も fetch しますが checkout、index、ローカルブランチ、ワークスペース記録は変更せず `plan:true` を返します。将来の merge/rebase コミット ID は不明なので `after:null` です。push、upstream の変更、hooks の実行はしません。

Both execution and dry runs use ordinary `git fetch` in the invoking repository. Before any fetch or integration, sync checks every configured fetch refspec of every involved remote and refuses with exit 4 `refused` if a positive refspec has a destination outside `refs/remotes/` or `refs/tags/` (including mirror mappings). Negative exclusions do not relax this conservative check; a missing or empty destination only writes `FETCH_HEAD` and is allowed. Use a tracking destination under `refs/remotes/` for custom namespaces. Sync also refuses any existing symbolic ref visible to `git for-each-ref` under `refs/remotes/` that points outside `refs/remotes/`; repair or remove the alias before retrying. Dangling symbolic refs are omitted by Git's enumeration and are not detected: this is a known limit shared with plain `git fetch`. Git retains its configured pruning, tags, negative exclusions and `followRemoteHEAD` behavior. Combined dry runs evaluate local bases against known tips planned for primary and earlier workspaces, in selection order.

戦略はフラグ `--auto`/`--rebase`/`--merge`、ユーザー設定 `sync.strategy`、既定の auto の順です。auto は未公開コミットを rebase、公開済みコミットを merge します。公開済みコミットを rebase する場合は終了コード 4 `published` で拒否し、`--rewrite-published` を案内します。フラグかユーザー設定 `sync.rewrite-published=true` で許可できます。許可は戦略を変更しないため、auto は引き続き公開済み履歴を merge します。設定値は auto|rebase|merge と true|false、不正値は終了コード 2。個人の方針はユーザー config.toml の `[sync]` に置き、リポジトリの `.mabo.toml` には置けません。

各 item は `strategySource`（flag/config/default）、`rewriteAllowed`、`rewriteSource`（flag/config/null）を別々に返します。実際に書き換えると `rewrotePublished:true` と対象名付きの `published_rewritten` warning（“updating the existing remote branch may require a force push”）を返します。dry-run では実際の書き換えは報告しません。

競合は復元して終了コード 5。`--keep-conflicts` はワークスペース単一対象のみで、進行中のまま残します。primary の更新は引き続き ff-only で、競合を残すワークスペースはひとつに限ります。何か更新した後の失敗・競合・拒否は 6 が優先します。更新なしなら運用エラーは 1、競合は 5、公開履歴の拒否は 4。スキップは既存どおり 0（primary 単独の dirty/diverged は既存どおり 1）。所有者、内部ロック、使用中検出はありません。

JSON envelope は schema 2 を維持し、`data: {plan, items:[{workspace,status,strategy,strategySource,rewriteAllowed,rewriteSource,rewrotePublished,before,after,conflicts,detail,code}], main:item|null}` です。workspace は統合前の共通観測オブジェクトです。診断用の name/path/branch/base も返します。状態は updated/up-to-date/dirty/diverged/integrated/detached/base-gone/base-unknown/conflict/refused/failed、primary には not-default-branch もあります。旧 merged は integrated に変わりました。

移行: sync の `-f`/`--force` は終了コード 2 で `--rewrite-published` を案内します。`--no-default` は現在のワークスペースだけが既定になったため終了コード 2、primary を進める `--main` を案内します。`--mine` も終了コード 2。JSON の default/workspaces は main/items に変わりました。
