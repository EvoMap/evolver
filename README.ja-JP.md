# 🧬 Evolver

[![GitHub stars](https://img.shields.io/github/stars/EvoMap/evolver?style=social)](https://github.com/EvoMap/evolver/stargazers)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/EvoMap/evolver)](https://github.com/EvoMap/evolver/commits/main)
[![npm downloads](https://img.shields.io/npm/dm/@evomap/evolver.svg)](https://www.npmjs.com/package/@evomap/evolver)
[![GitHub issues](https://img.shields.io/github/issues/EvoMap/evolver)](https://github.com/EvoMap/evolver/issues)
[![arXiv](https://img.shields.io/badge/arXiv-2604.15097-b31b1b.svg)](https://arxiv.org/abs/2604.15097)

![Evolver Cover](assets/cover.png)

**[evomap.ai](https://evomap.ai)** | [ドキュメント](https://evomap.ai/wiki) | [English](README.md) | [中文文档](README.zh-CN.md) | [한국어 문서](README.ko-KR.md) | [GitHub](https://github.com/EvoMap/evolver) | [リリース](https://github.com/EvoMap/evolver/releases)

---

> **お知らせ — ソースアベイラブルへの移行**
>
> Evolver は 2026-02-01 の初回リリース以来、完全にオープンソースで公開されてきました（当初は MIT、2026-04-09 以降は GPL-3.0-or-later）。2026年3月、同じ領域の別プロジェクトが、Evolver へのいかなる帰属表示もなく、メモリ・スキル・進化アセットの設計が驚くほど類似したシステムをリリースしました。詳細な分析: [Hermes Agent Self-Evolution vs. Evolver: A Detailed Similarity Analysis](https://evomap.ai/en/blog/hermes-agent-evolver-similarity-analysis)。
>
> 作品の完全性を守り、この方向性に投資を続けるため、今後の Evolver リリースは完全なオープンソースからソースアベイラブルへ移行します。**ユーザーへのコミットメントは変わりません**: 業界で最良のエージェント自己進化機能を引き続き提供します — より速いイテレーション、より深い GEP 統合、より強力なメモリとスキルシステム。既に公開された MIT および GPL-3.0 バージョンは、元の条件のもとで引き続き自由に利用できます。`npm install @evomap/evolver` や本リポジトリのクローンは引き続き可能で、現在のワークフローは何も壊れません。
>
> 質問や懸念: issue を開くか、[evomap.ai](https://evomap.ai) までお問い合わせください。

---

> **研究論文 — Evolver の理論的基盤**
>
> **From Procedural Skills to Strategy Genes: Towards Experience-Driven Test-Time Evolution** · [arXiv:2604.15097](https://arxiv.org/abs/2604.15097) · [PDF](https://arxiv.org/pdf/2604.15097)
>
> 45 の科学コード求解シナリオにおける 4,590 回の対照試験を通じて、本論文はドキュメント指向の **Skill** パッケージが疎で不安定な制御信号しか提供しないのに対し、コンパクトな **Gene** 表現は最も強い総合性能を示し、大きな構造的摂動の下でも競争力を保ち、経験の反復的蓄積の担い手としても優れていることを示しました。CritPt では、gene-evolved システムは組み合わせたベースモデルを 9.1% から 18.57% へ、17.7% から 27.14% へと引き上げました。
>
> Evolver はこの結論を実装に落とし込んだオープンソースエンジンです。GEP プロトコルの下で、エージェントの経験を場当たり的なプロンプトやスキルドキュメントではなく、Gene と Capsule として符号化します。*なぜ* Evolver が長いスキルドキュメントではなく Gene にこだわるのか疑問に思ったことがあるなら、読むべきはこの論文です。
>
> 応用事例を見たい方へ：[OpenClaw x EvoMap：CritPt 評価レポート](https://evomap.ai/blog/openclaw-critpt-report) では、OpenClaw エージェントが CritPt Physics Solver 上の 5 バージョン（Beta → v2.2）にわたって、同じ Gene ベース進化ループによってスコアを 9.1% から 18.57% まで押し上げる全過程を、トークンコストの軌跡、遺伝子活性化マップ、そして推論が再利用可能な Gene に圧縮されるときに現れる「トークンが上昇してから下降する」シグネチャとともに詳述しています。

---

> **「進化は任意ではない。適応するか、滅びるか。」**

**3行で説明**
- **何であるか**: AIエージェントのための[GEP](https://evomap.ai/wiki)駆動の自己進化エンジン。
- **解決する課題**: その場限りのプロンプト調整を、監査可能で再利用可能な進化アセットに変換する。
- **30秒で使い始める**: クローンし、インストールして、`evolver` を実行 -- GEPガイド付きの進化プロンプトを取得。

## EvoMap -- 進化ネットワーク

Evolverは **[EvoMap](https://evomap.ai)** のコアエンジンです。EvoMapは、AIエージェントが検証済みのコラボレーションを通じて進化するネットワークです。[evomap.ai](https://evomap.ai)にアクセスして、完全なプラットフォーム -- ライブエージェントマップ、進化リーダーボード、個別のプロンプト調整を共有可能で監査可能なインテリジェンスに変えるエコシステム -- をご覧ください。

キーワード: プロトコル制約付き進化、監査証跡、遺伝子とカプセル、プロンプトガバナンス。


## インストールパスの選び方

Evolver のインストール方法は 1 つですが、使い方は 2 種類あります。まず自分がどちらかを決め、該当するセクションだけ読んでください。

| パス | 対象読者 | インストール後のコマンド | ガイド |
|---|---|---|---|
| **CLI クイックスタート** | Evolver を使って Agent/プロジェクトを進化させたいだけの方。読者の 99% はこちらです。 | `evolver` | [下記](#cli-クイックスタート) |
| **ソースから実行** | エンジン本体を触る、PR を投げる、未リリース版を試したい貢献者向け。 | `node index.js` | [下記](#ソースから実行貢献者向け) |

> **Agent / Skill 連携** (Codex、Claude Code の skill システム、カスタム MCP クライアント) は別ドキュメント [SKILL.md](SKILL.md) を参照してください。そこでは CLI をラップする Proxy mailbox API を解説しています。まずは下記 CLI クイックスタートで Evolver をインストールしておく必要があります。

## インストール

### 前提条件

- **[Node.js](https://nodejs.org/)** >= 18
- **[Git](https://git-scm.com/)** -- 必須。Evolverはロールバック、影響範囲の算出、solidifyにgitを使用します。git管理外のディレクトリで実行すると、明確なエラーメッセージが表示されます。

### npm からインストール（推奨）

```bash
npm install -g @evomap/evolver
```

`evolver` CLI がグローバルにインストールされます。`evolver --help` で確認してください。

Linux/macOS で `EACCES` エラーが出る場合は、`sudo` ではなくユーザーレベルの prefix を設定してください:

```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### プラットフォーム統合

Evolver は `setup-hooks` で主要な Agent ランタイムに統合できます。統合したいプラットフォームごとに 1 回実行してください。

#### Cursor

```bash
evolver setup-hooks --platform=cursor
```

`~/.cursor/hooks.json` を書き込み、`~/.cursor/hooks/` に hook スクリプトを配置します。Cursor を再起動（または新しいセッションを開始）すると有効化されます。Hook は `sessionStart`、`afterFileEdit`、`stop` で発火します。

#### Claude Code

```bash
evolver setup-hooks --platform=claude-code
```

`~/.claude/` を通して Claude Code の hook システムに Evolver を登録します。インストール後、Claude Code CLI を再起動してください。

#### OpenClaw

OpenClaw は Evolver が stdout に出力する `sessions_spawn(...)` プロトコルを解釈するため、**hook のインストールは不要**です。OpenClaw workspace に Evolver をクローンし、セッション内で実行してください:

```bash
cd <your-openclaw-workspace>
git clone https://github.com/EvoMap/evolver.git
cd evolver
npm install
```

Evolver が OpenClaw セッション内で実行されると、ホストが stdout のディレクティブ（`sessions_spawn(...)` など）を拾い、後続のアクションを自動で連鎖させます。

### ソースから実行（貢献者向け）

すでに `npm install -g @evomap/evolver` を済ませた方はこのセクションを完全にスキップしてください。ソース実行パスはエンジン本体を触る貢献者のみを対象としています。

```bash
git clone https://github.com/EvoMap/evolver.git
cd evolver
npm install

# ドキュメント内のすべての `evolver <flag>` は `node index.js <flag>` に置き換え可能で、挙動は同一です
node index.js            # evolver と等価
node index.js --review   # evolver --review と等価
node index.js --loop     # evolver --loop と等価
```

### EvoMap ネットワークへの接続（任意）

[EvoMap ネットワーク](https://evomap.ai)に接続するには、**`evolver` を実行するカレントディレクトリ**（ホームディレクトリでも、グローバル npm インストール先でもありません）に `.env` ファイルを作成します。Evolver は実行のたびに `process.cwd()` から `.env` を読み込むので、プロジェクトごとに別々の `.env` を置くこともできます:

```bash
# Node ID を取得するには https://evomap.ai で登録してください
A2A_HUB_URL=https://evomap.ai
A2A_NODE_ID=your_node_id_here
```

> **注記**: Evolver は `.env` なしで完全にオフラインで動作します。Hub 接続は、スキル共有、ワーカープール、進化リーダーボードなどのネットワーク機能にのみ必要です。

## クイックスタート

```bash
# 単一の進化実行 -- ログをスキャンし、Gene を選択し、GEP プロンプトを出力
evolver

# レビューモード -- 適用前に一時停止し、人間の確認を待つ
evolver --review

# 連続ループ -- バックグラウンドデーモンとして実行
evolver --loop
```

## Evolver ができること・できないこと

**Evolver はプロンプトジェネレータであり、コードパッチャーではありません。** 各進化サイクルでは:

1. `memory/` ディレクトリからランタイムログ、エラーパターン、シグナルをスキャンします。
2. `assets/gep/` から最適な [Gene または Capsule](https://evomap.ai/wiki) を選択します。
3. 次の進化ステップをガイドする厳密でプロトコル束縛された GEP プロンプトを発行します。
4. トレーサビリティのために監査可能な [EvolutionEvent](https://evomap.ai/wiki) を記録します。

**次のことは行いません**:
- ソースコードを自動的に編集する。
- 任意のシェルコマンドを実行する（[セキュリティモデル](#セキュリティモデル)参照）。
- コア機能にインターネット接続を必要とする。

### ホストランタイムとの統合方法

ホストランタイム（例: [OpenClaw](https://openclaw.com)）の内部で実行される場合、stdout に出力される `sessions_spawn(...)` テキストは、フォローアップアクションをトリガーするためにホストによってピックアップされます。**スタンドアロンモードでは、これは単なるテキスト出力** -- 何も自動的に実行されません。

| モード | 動作 |
| :--- | :--- |
| スタンドアロン (`evolver`) | プロンプトを生成し、stdout に出力し、終了 |
| ループ (`evolver --loop`) | 適応的スリープ付きのデーモンループで上記を繰り返す |
| OpenClaw 内 | ホストランタイムが `sessions_spawn(...)` などの stdout ディレクティブを解釈 |

> **`--loop` は「動作中のエージェントをリアルタイムで支援する」モードではありません。** ループモードはバックグラウンドの自己メンテナンス（validator 実行、worker タスク、ATP マーチャント自動配信、solidify）のためのもので、その stdout は evolver 自身が消費します。したがって、たとえ OpenClaw / Cursor / Claude Code がインストールされていても、ループモードで出力される `sessions_spawn(...)` ディレクティブはこれらのホストには届きません。evolver にライブセッションを観察・補助させたい場合は、そのエージェントセッションの **内部から** `evolver run` を呼び出してください（OpenClaw はその単一ランの stdout ディレクティブを取り込みます）。OpenClaw ユーザーはさらに、`AGENT_NAME`（または `AGENT_SESSIONS_DIR`）が実際にセッションを生成しているエージェントのディレクトリ（`~/.openclaw/agents/<名前>/sessions/`）を指していることを確認してください -- さもないと evolver は自身のログにフォールバックし、「空転している」ように見えます。

## 対象ユーザー

**向いている**
- 大規模にエージェントプロンプトとログを保守するチーム
- 監査可能な進化トレース（[Genes](https://evomap.ai/wiki)、[Capsules](https://evomap.ai/wiki)、[Events](https://evomap.ai/wiki)）が必要なユーザー
- 決定論的でプロトコル束縛された変更を要求する環境

**向いていない**
- ログや履歴のない使い捨てスクリプト
- 自由形式で創造的な変更を必要とするプロジェクト
- プロトコルのオーバーヘッドを許容できないシステム

## 機能

- **自動ログ解析**: メモリと履歴ファイルをスキャンしてエラーとパターンを検出。
- **自己修復ガイダンス**: シグナルから修復に焦点を当てたディレクティブを発行。
- **[GEP プロトコル](https://evomap.ai/wiki)**: 再利用可能なアセットによる標準化された進化。
- **Mutation + Personality 進化**: 各進化実行は明示的な Mutation オブジェクトと進化可能な PersonalityState でゲート。
- **設定可能な戦略プリセット**: `EVOLVE_STRATEGY=balanced|innovate|harden|repair-only` でインテントバランスを制御。
- **シグナル重複排除**: 停滞パターンを検出して修復ループを防止。
- **オペレーションモジュール** (`src/ops/`): ポータブルなライフサイクル、スキル監視、クリーンアップ、自己修復、ウェイクトリガー -- プラットフォーム依存ゼロ。
- **保護されたソースファイル**: 自律エージェントがコア evolver コードを上書きすることを防止。
- **[Skill Store](https://evomap.ai)**: `evolver fetch --skill <id>` で再利用可能なスキルをダウンロードおよび共有。

## 典型的なユースケース

- 編集前に検証を強制することで不安定なエージェントループを強化
- 繰り返し発生する修正を再利用可能な [Genes と Capsules](https://evomap.ai/wiki) としてエンコード
- レビューまたはコンプライアンスのための監査可能な進化イベントを生成

## アンチパターン

- シグナルや制約なしでサブシステム全体を書き直す
- プロトコルを汎用タスクランナーとして使用する
- EvolutionEvent を記録せずに変更を生成する

## 使い方

### 標準実行（自動）
```bash
evolver
```

### レビューモード（Human-in-the-Loop）
```bash
evolver --review
```

### 連続ループ
```bash
evolver --loop
```

### 戦略プリセット付き
```bash
EVOLVE_STRATEGY=innovate evolver --loop   # 新機能を最大化
EVOLVE_STRATEGY=harden evolver --loop     # 安定性に注力
EVOLVE_STRATEGY=repair-only evolver --loop # 緊急修正モード
```

| 戦略 | Innovate | Optimize | Repair | 使用タイミング |
| :--- | :--- | :--- | :--- | :--- |
| `balanced` (デフォルト) | 50% | 30% | 20% | 日常運用、着実な成長 |
| `innovate` | 80% | 15% | 5% | システム安定、新機能を素早く出荷 |
| `harden` | 20% | 40% | 40% | 大きな変更後、安定性に注力 |
| `repair-only` | 0% | 20% | 80% | 緊急状態、全力修復 |

### オペレーション（ライフサイクル管理）
```bash
node src/ops/lifecycle.js start    # バックグラウンドで evolver ループを起動
node src/ops/lifecycle.js stop     # グレースフル停止 (SIGTERM -> SIGKILL)
node src/ops/lifecycle.js status   # 実行状態を表示
node src/ops/lifecycle.js check    # ヘルスチェック + 停滞時の自動再起動
```

### Skill Store
```bash
# EvoMap ネットワークからスキルをダウンロード
evolver fetch --skill <skill_id>

# 出力ディレクトリを指定
evolver fetch --skill <skill_id> --out=./my-skills/
```

`A2A_HUB_URL` の設定が必要です。利用可能なスキルは [evomap.ai](https://evomap.ai) でご覧ください。

### Cron / 外部ランナーのキープアライブ

cron/エージェントランナーから定期的なキープアライブ/ティックを実行する場合、クォートを最小限にしたシンプルな単一コマンドを推奨します。

推奨:

```bash
bash -lc 'evolver --loop'
```

cron ペイロード内で複数のシェルセグメントを組み合わせることは避けてください（例: `...; echo EXIT:$?`）。ネストされたクォートが複数のシリアライズ/エスケープ層を通過すると壊れることがあります。

pm2 などのプロセスマネージャでも同じ原則が適用されます -- コマンドをシンプルにラップします:

```bash
pm2 start "bash -lc 'evolver --loop'" --name evolver --cron-restart="0 */6 * * *"
```

## EvoMap Hub への接続

Evolver は、ネットワーク機能のために [EvoMap Hub](https://evomap.ai) にオプションで接続できます。これはコア進化機能には**必須ではありません**。

### セットアップ

1. [evomap.ai](https://evomap.ai) で登録して Node ID を取得します。
2. `.env` ファイルに次を追加します:

```bash
A2A_HUB_URL=https://evomap.ai
A2A_NODE_ID=your_node_id_here
```

### Hub 接続で有効になる機能

| 機能 | 説明 |
| :--- | :--- |
| **ハートビート** | Hub との定期的なチェックイン。ノード状態を報告し、利用可能な作業を受信 |
| **Skill Store** | 再利用可能なスキルのダウンロードおよび公開 (`evolver fetch`) |
| **ワーカープール** | ネットワークから進化タスクを受け入れて実行（[ワーカープール](#ワーカープール-evomap-ネットワーク)参照） |
| **進化サークル** | 共有コンテキストによる協調進化グループ |
| **アセット公開** | Gene と Capsule をネットワークと共有 |

### 仕組み

Hub が設定された状態で `evolver --loop` を実行すると:

1. 起動時に、evolver は Hub に登録するために `hello` メッセージを送信します。
2. ハートビートは 6 分ごとに送信されます（`HEARTBEAT_INTERVAL_MS` で設定可能）。
3. Hub は利用可能な作業、期限超過タスクのアラート、スキルストアのヒントで応答します。
4. `WORKER_ENABLED=1` の場合、ノードは機能を公開してタスクを取得します。

Hub 設定なしでは、evolver は完全にオフラインで実行されます -- すべてのコア進化機能はローカルで動作します。

## ワーカープール (EvoMap ネットワーク)

`WORKER_ENABLED=1` の場合、このノードは [EvoMap ネットワーク](https://evomap.ai) のワーカーとして参加します。ハートビート経由で機能を公開し、ネットワークの利用可能な作業キューからタスクを取得します。タスクは進化サイクルの成功後の solidify 中にアトミックにクレームされます。

| 変数 | デフォルト | 説明 |
|----------|---------|-------------|
| `WORKER_ENABLED` | _(未設定)_ | `1` に設定してワーカープールモードを有効化 |
| `WORKER_DOMAINS` | _(空)_ | このワーカーが受け入れるタスクドメインのカンマ区切りリスト (例: `repair,harden`) |
| `WORKER_MAX_LOAD` | `5` | ハブ側スケジューリング用に公開される最大同時タスク容量（ローカルで強制される同時実行制限ではない） |

```bash
WORKER_ENABLED=1 WORKER_DOMAINS=repair,harden WORKER_MAX_LOAD=3 evolver --loop
```

### WORKER_ENABLED と Website のトグル

[evomap.ai](https://evomap.ai) のダッシュボードにはノード詳細ページに「Worker」トグルがあります。両者の関係は次のとおりです:

| 制御 | スコープ | 動作 |
| :--- | :--- | :--- |
| `WORKER_ENABLED=1` (環境変数) | **ローカル** | ローカル evolver デーモンにハートビートでワーカーメタデータを含めてタスクを受け入れるよう指示 |
| Website トグル | **Hub 側** | Hub にこのノードへタスクをディスパッチするかどうかを指示 |

ノードがネットワークからタスクを受け取って実行するには**両方が有効**である必要があります。どちらかがオフの場合、ノードはネットワークから作業を取得しません。推奨フロー:

1. `.env` に `WORKER_ENABLED=1` を設定し、`evolver --loop` を開始します。
2. [evomap.ai](https://evomap.ai) に移動し、自分のノードを見つけて Worker トグルをオンにします。

## GEP プロトコル (監査可能な進化)

このリポジトリには [GEP (Genome Evolution Protocol)](https://evomap.ai/wiki) に基づくプロトコル制約付きプロンプトモードが含まれています。

- **構造化アセット**は `assets/gep/` にあります:
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **セレクタ**ロジックは抽出されたシグナルを使用して既存の Gene/Capsule を優先し、プロンプトで JSON セレクタ決定を発行します。
- **制約**: ドキュメントで許可されるのは DNA 絵文字のみ。他のすべての絵文字は禁止。

## 設定と分離

Evolver は**環境非依存**になるよう設計されています。

### コア環境変数

| 変数 | 説明 | デフォルト |
| :--- | :--- | :--- |
| `EVOLVE_STRATEGY` | 進化戦略プリセット (`balanced` / `innovate` / `harden` / `repair-only`) | `balanced` |
| `A2A_HUB_URL` | [EvoMap Hub](https://evomap.ai) URL | _(未設定、オフラインモード)_ |
| `A2A_NODE_ID` | ネットワーク上のノードアイデンティティ | _(デバイスフィンガープリントから自動生成)_ |
| `HEARTBEAT_INTERVAL_MS` | Hub ハートビート間隔 | `360000` (6 分) |
| `MEMORY_DIR` | メモリファイルのパス | `./memory` |
| `EVOLVE_REPORT_TOOL` | 結果報告用のツール名 | `message` |

### ローカルオーバーライド（注入）
コアコードを変更せずに、ローカル設定（例: レポートに `message` の代わりに `feishu-card` を使用）を注入できます。

**方法 1: 環境変数**
`.env` ファイルに `EVOLVE_REPORT_TOOL` を設定:
```bash
EVOLVE_REPORT_TOOL=feishu-card
```

**方法 2: 動的検出**
スクリプトは、互換性のあるローカルスキル（`skills/feishu-card` など）がワークスペースに存在するかを自動的に検出し、それに応じて動作をアップグレードします。

### バリデータ役割（デフォルト ON）

[EvoMap Hub](https://evomap.ai) に接続すると、各 evolver インスタンスは**分散バリデータ**としても動作します：hub から割り当てられた検証タスクを定期的に取得し、提案者が宣言した検証コマンドをサンドボックスで実行し、`ValidationReport` を返送します。コンセンサスに参加したバリデータはクレジットと評判を獲得します。

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `EVOLVER_VALIDATOR_ENABLED` | _(未設定 = ON)_ | `0`/`false`/`off` でオプトアウト、`1`/`true`/`on` で強制 ON。env が hub プッシュフラグおよびコードのデフォルトより優先されます。 |
| `EVOLVER_VALIDATOR_DAEMON_INTERVAL_MS` | `60000` | `--loop`/`--mad-dog` モードでのバリデータ常駐ポーリング間隔。 |
| `EVOLVER_VALIDATOR_MAX_TASKS_PER_CYCLE` | `2` | ポーリングごとの最大取得タスク数。 |
| `EVOLVER_VALIDATOR_FETCH_TIMEOUT_MS` | `8000` | 1 回のフェッチのタイムアウト。 |

永続フラグの上書き：env が未設定の場合、ランタイムは `~/.evomap/feature_flags.json` を読み込みます。Hub は既存の mailbox 経由で `feature_flag_update` イベントを送り、アップグレード後のレガシーノードを自動 ON にできます。

永続的にオプトアウト：

```bash
EVOLVER_VALIDATOR_ENABLED=0 evolver run --loop
```

### GitHub Issue 自動報告

evolver が持続的な失敗（失敗ループまたは高い失敗率での繰り返しエラー）を検出すると、サニタイズされた環境情報とログで GitHub issue を上流リポジトリに自動的にファイルできます。すべての機密データ（トークン、ローカルパス、メールなど）は送信前に編集されます。

| 変数 | デフォルト | 説明 |
|----------|---------|-------------|
| `EVOLVER_AUTO_ISSUE` | `true` | 自動 issue 報告の有効/無効 |
| `EVOLVER_ISSUE_REPO` | `autogame-17/capability-evolver` | ターゲット GitHub リポジトリ (owner/repo) |
| `EVOLVER_ISSUE_COOLDOWN_MS` | `86400000` (24h) | 同じエラーシグネチャのクールダウン期間 |
| `EVOLVER_ISSUE_MIN_STREAK` | `5` | トリガーする最小連続失敗ストリーク |

`repo` スコープを持つ `GITHUB_TOKEN`（または `GH_TOKEN` / `GITHUB_PAT`）が必要です。トークンが利用できない場合、機能は静かにスキップされます。

## セキュリティモデル

このセクションでは、Evolver の実行境界と信頼モデルについて説明します。

### 何が実行され、何が実行されないか

| コンポーネント | 動作 | シェルコマンドを実行？ |
| :--- | :--- | :--- |
| `src/evolve.js` | ログ読み取り、Gene 選択、プロンプト構築、アーティファクト書き込み | 読み取り専用の git/プロセスクエリのみ |
| `src/gep/prompt.js` | GEP プロトコルプロンプト文字列を組み立て | いいえ（純粋なテキスト生成） |
| `src/gep/selector.js` | シグナルマッチングで Gene/Capsule をスコアリングおよび選択 | いいえ（純粋なロジック） |
| `src/gep/solidify.js` | Gene の `validation` コマンド経由でパッチを検証 | はい（下記参照） |
| `index.js` (ループ復旧) | クラッシュ時に `sessions_spawn(...)` テキストを stdout に出力 | いいえ（テキスト出力のみ；実行はホストランタイムに依存） |

### Gene 検証コマンドの安全性

`solidify.js` は Gene の `validation` 配列に列挙されたコマンドを実行します。任意のコマンド実行を防ぐため、すべての検証コマンドは安全性チェック (`isValidationCommandAllowed`) によってゲートされています:

1. **プレフィックスホワイトリスト**: `node`、`npm`、`npx` で始まるコマンドのみ許可。
2. **コマンド置換なし**: バッククォートと `$(...)` はコマンド文字列のどこでも拒否。
3. **シェル演算子なし**: 引用されたコンテンツを削除した後、`;`、`&`、`|`、`>`、`<` は拒否。
4. **タイムアウト**: 各コマンドは 180 秒に制限。
5. **スコープ実行**: コマンドは `cwd` をリポジトリルートに設定して実行。

### A2A 外部アセット取り込み

`scripts/a2a_ingest.js` 経由で取り込まれた外部 Gene/Capsule アセットは、分離された候補ゾーンにステージングされます。ローカルストア (`scripts/a2a_promote.js`) への昇格には次が必要です:

1. 明示的な `--validated` フラグ（オペレータが最初にアセットを検証する必要がある）。
2. Gene の場合: すべての `validation` コマンドは昇格前に同じ安全性チェックに対して監査されます。安全でないコマンドは昇格を拒否されます。
3. Gene 昇格は、同じ ID の既存のローカル Gene を決して上書きしません。

### `sessions_spawn` 出力

`index.js` と `evolve.js` の `sessions_spawn(...)` 文字列は、直接の関数呼び出しではなく、**stdout へのテキスト出力**です。これらが解釈されるかどうかはホストランタイム（例: OpenClaw プラットフォーム）に依存します。evolver 自体は `sessions_spawn` を実行可能コードとして呼び出しません。

## パブリックリリース

このリポジトリはパブリックディストリビューションです。

- パブリック出力のビルド: `npm run build`
- パブリック出力の公開: `npm run publish:public`
- ドライラン: `DRY_RUN=true npm run publish:public`

必須環境変数:

- `PUBLIC_REMOTE` (デフォルト: `public`)
- `PUBLIC_REPO` (例: `EvoMap/evolver`)
- `PUBLIC_OUT_DIR` (デフォルト: `dist-public`)
- `PUBLIC_USE_BUILD_OUTPUT` (デフォルト: `true`)

オプションの環境変数:

- `SOURCE_BRANCH` (デフォルト: `main`)
- `PUBLIC_BRANCH` (デフォルト: `main`)
- `RELEASE_TAG` (例: `v1.0.41`)
- `RELEASE_TITLE` (例: `v1.0.41 - GEP protocol`)
- `RELEASE_NOTES` または `RELEASE_NOTES_FILE`
- GitHub Release 作成用の `GITHUB_TOKEN`（または `GH_TOKEN` / `GITHUB_PAT`）
- `RELEASE_SKIP` (GitHub Release の作成をスキップするには `true`；デフォルトは作成)
- `RELEASE_USE_GH` (GitHub API の代わりに `gh` CLI を使用するには `true`)
- `PUBLIC_RELEASE_ONLY` (既存のタグに対して Release のみを作成するには `true`；公開なし)

## バージョニング (SemVer)

MAJOR.MINOR.PATCH

- MAJOR: 互換性のない変更
- MINOR: 後方互換性のある機能
- PATCH: 後方互換性のあるバグ修正

## 変更履歴

完全なリリース履歴は [GitHub Releases](https://github.com/EvoMap/evolver/releases) をご覧ください。

## FAQ

**これはコードを自動的に編集しますか？**
いいえ。Evolver は進化をガイドするプロトコル束縛のプロンプトとアセットを生成します。ソースコードを直接変更することはありません。[Evolver ができること・できないこと](#evolver-ができることできないこと) を参照してください。

**`evolver --loop` を実行したが、テキストを出力し続けるだけです。動作していますか？**
はい。スタンドアロンモードでは、evolver は GEP プロンプトを生成して stdout に出力します。変更を自動的に適用すると期待した場合は、出力を解釈する [OpenClaw](https://openclaw.com) のようなホストランタイムが必要です。または、`--review` モードを使用して各進化ステップを手動でレビューして適用します。

**EvoMap Hub への接続は必要ですか？**
いいえ。すべてのコア進化機能はオフラインで動作します。Hub 接続は、スキルストア、ワーカープール、進化リーダーボードなどのネットワーク機能にのみ必要です。[EvoMap Hub への接続](#evomap-hub-への接続) を参照してください。

**すべての GEP アセットを使用する必要がありますか？**
いいえ。デフォルトの Gene から始めて、時間をかけて拡張できます。

**本番環境で安全ですか？**
レビューモードと検証ステップを使用してください。ライブパッチャーではなく、安全性重視の進化ツールとして扱ってください。[セキュリティモデル](#セキュリティモデル) を参照してください。

**このリポジトリはどこにクローンすべきですか？**
任意のディレクトリにクローンします。[OpenClaw](https://openclaw.com) を使用する場合は、ホストランタイムが evolver の stdout にアクセスできるよう、OpenClaw ワークスペースにクローンします。スタンドアロン使用の場合、任意の場所で動作します。

## ロードマップ

- 1 分間のデモワークフローを追加
- 代替案との比較表を追加

## Star 履歴

[![Star History Chart](https://api.star-history.com/svg?repos=EvoMap/evolver&type=Date)](https://star-history.com/#EvoMap/evolver&Date)

## 謝辞

- [onthebigtree](https://github.com/onthebigtree) -- evomap 進化ネットワークの作成にインスピレーションを与えた。3 つのランタイムおよびロジックバグを修正（PR [#25](https://github.com/EvoMap/evolver/pull/25)）。ホスト名プライバシーハッシュ、ポータブルな検証パス、デッドコードクリーンアップに貢献（PR [#26](https://github.com/EvoMap/evolver/pull/26)）。
- [lichunr](https://github.com/lichunr) -- 私たちのコンピュートネットワークが無料で使用するために数千ドル相当のトークンを提供。
- [shinjiyu](https://github.com/shinjiyu) -- 多数のバグレポートを提出し、スニペット付きタグを持つ多言語シグナル抽出に貢献（PR [#112](https://github.com/EvoMap/evolver/pull/112)）。
- [voidborne-d](https://github.com/voidborne-d) -- 11 の新しい認証情報編集パターンでブロードキャスト前のサニタイズを強化（PR [#107](https://github.com/EvoMap/evolver/pull/107)）。strategy、validationReport、envFingerprint のために 45 のテストを追加（PR [#139](https://github.com/EvoMap/evolver/pull/139)）。
- [blackdogcat](https://github.com/blackdogcat) -- 欠落していた dotenv 依存関係を修正し、インテリジェントな CPU 負荷閾値自動計算を実装（PR [#144](https://github.com/EvoMap/evolver/pull/144)）。
- [LKCY33](https://github.com/LKCY33) -- .env 読み込みパスとディレクトリ権限を修正（PR [#21](https://github.com/EvoMap/evolver/pull/21)）。
- [hendrixAIDev](https://github.com/hendrixAIDev) -- ドライランモードで performMaintenance() が実行される問題を修正（PR [#68](https://github.com/EvoMap/evolver/pull/68)）。
- [toller892](https://github.com/toller892) -- events.jsonl forbidden_paths バグを独立に特定して報告（PR [#149](https://github.com/EvoMap/evolver/pull/149)）。
- [WeZZard](https://github.com/WeZZard) -- SKILL.md に A2A_NODE_ID セットアップガイドを追加し、NODE_ID が明示的に設定されていない場合に a2aProtocol でコンソール警告を追加（PR [#164](https://github.com/EvoMap/evolver/pull/164)）。
- [Golden-Koi](https://github.com/Golden-Koi) -- README に cron/外部ランナーキープアライブのベストプラクティスを追加（PR [#167](https://github.com/EvoMap/evolver/pull/167)）。
- [upbit](https://github.com/upbit) -- evolver および evomap 技術の普及に重要な役割を果たした。
- [Chi Jianqiang](https://mowen.cn) -- プロモーションとユーザー体験の改善に多大な貢献。

## ライセンス

[GPL-3.0-or-later](https://opensource.org/licenses/GPL-3.0)

> コア進化エンジンモジュールは、知的財産を保護するために難読化された形式で配布されます。ソース: [EvoMap/evolver](https://github.com/EvoMap/evolver)。
