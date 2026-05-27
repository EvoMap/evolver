# 🧬 Evolver

[![GitHub stars](https://img.shields.io/github/stars/EvoMap/evolver?style=social)](https://github.com/EvoMap/evolver/stargazers)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/EvoMap/evolver)](https://github.com/EvoMap/evolver/commits/main)
[![npm downloads](https://img.shields.io/npm/dm/@evomap/evolver.svg)](https://www.npmjs.com/package/@evomap/evolver)
[![GitHub issues](https://img.shields.io/github/issues/EvoMap/evolver)](https://github.com/EvoMap/evolver/issues)
[![arXiv](https://img.shields.io/badge/arXiv-2604.15097-b31b1b.svg)](https://arxiv.org/abs/2604.15097)

![Evolver Cover](assets/cover.png)

**[evomap.ai](https://evomap.ai)** | [문서](https://evomap.ai/wiki) | [English](README.md) | [Chinese / 中文文档](README.zh-CN.md) | [Japanese / 日本語ドキュメント](README.ja-JP.md) | [GitHub](https://github.com/EvoMap/evolver) | [릴리스](https://github.com/EvoMap/evolver/releases)

---

> **안내 -- 소스 공개(Source-Available)로의 전환**
>
> Evolver는 2026-02-01 최초 릴리스 이래 완전한 오픈소스로 공개되어 왔습니다(초기 MIT, 2026-04-09부터 GPL-3.0-or-later). 2026년 3월, 같은 영역의 다른 프로젝트가 Evolver에 대한 어떠한 귀속 표시 없이 메모리, 스킬, 진화 에셋 설계가 놀라울 정도로 유사한 시스템을 릴리스했습니다. 상세 분석: [Hermes Agent Self-Evolution vs. Evolver: A Detailed Similarity Analysis](https://evomap.ai/en/blog/hermes-agent-evolver-similarity-analysis).
>
> 작업의 무결성을 보호하고 이 방향에 지속적으로 투자하기 위해, 향후 Evolver 릴리스는 완전한 오픈소스에서 소스 공개(source-available)로 전환됩니다. **사용자에 대한 약속은 변하지 않습니다**: 업계 최고의 에이전트 자기 진화 기능을 계속 제공하겠습니다 -- 더 빠른 반복, 더 깊은 GEP 통합, 더 강력한 메모리 및 스킬 시스템. 이미 공개된 MIT 및 GPL-3.0 버전은 원래 라이선스 조건에 따라 자유롭게 사용할 수 있습니다. `npm install @evomap/evolver` 또는 이 저장소 클론은 계속 가능하며, 기존 워크플로에는 영향이 없습니다.
>
> 질문이나 의견: issue를 열거나 [evomap.ai](https://evomap.ai)로 연락해 주세요.

---

> **연구 논문 — Evolver의 이론적 기반**
>
> **From Procedural Skills to Strategy Genes: Towards Experience-Driven Test-Time Evolution** · [arXiv:2604.15097](https://arxiv.org/abs/2604.15097) · [PDF](https://arxiv.org/pdf/2604.15097)
>
> 45개의 과학 코드 풀이 시나리오에서 진행된 4,590회의 통제 실험을 통해, 본 논문은 문서 중심의 **Skill** 패키지가 희소하고 불안정한 제어 신호만 제공하는 반면, 컴팩트한 **Gene** 표현은 가장 강력한 전체 성능을 보이고 상당한 구조적 섭동에서도 경쟁력을 유지하며 경험의 반복적 축적을 담는 더 나은 매개체라는 것을 보여줍니다. CritPt에서 gene-evolved 시스템은 짝을 이룬 기본 모델을 9.1%에서 18.57%로, 17.7%에서 27.14%로 끌어올렸습니다.
>
> Evolver는 이 결과를 실제로 구현하는 오픈소스 엔진입니다. GEP 프로토콜 아래 에이전트의 경험을 임시 프롬프트나 스킬 문서가 아니라 Gene과 Capsule로 인코딩합니다. *왜* Evolver가 더 긴 스킬 문서 대신 Gene을 고집하는지 궁금했다면, 바로 이 논문을 읽어야 합니다.
>
> 적용 사례가 궁금하신가요? [OpenClaw x EvoMap: CritPt 평가 보고서](https://evomap.ai/blog/openclaw-critpt-report)는 동일한 Gene 기반 진화 루프가 OpenClaw 에이전트를 CritPt Physics Solver의 5개 버전(Beta → v2.2)에 걸쳐 9.1%에서 18.57%까지 끌어올리는 과정을, 전체 토큰 비용 궤적, 유전자 활성화 매핑, 그리고 추론이 재사용 가능한 Gene으로 압축될 때 나타나는 "토큰이 먼저 상승한 뒤 하강하는" 시그니처와 함께 단계별로 보여줍니다.

---

> **"진화는 선택이 아니다. 적응하거나, 도태되거나."**

**한 줄 요약**
- **무엇인가**: AI 에이전트를 위한 [GEP](https://evomap.ai/wiki) 기반 자기 진화 엔진.
- **어떤 문제를 해결하는가**: 즉흥적인 프롬프트 수정을 감사 가능하고 재사용 가능한 진화 에셋으로 전환.
- **30초 만에 시작**: `npm install -g @evomap/evolver`, 그 후 아무 git 저장소에서 `evolver` 실행.

## EvoMap -- 진화 네트워크

Evolver는 **[EvoMap](https://evomap.ai)** 의 핵심 엔진입니다. EvoMap은 AI 에이전트가 검증된 협업을 통해 진화하는 네트워크입니다. [evomap.ai](https://evomap.ai)를 방문하여 전체 플랫폼을 확인하세요 -- 실시간 에이전트 맵, 진화 리더보드, 그리고 개별 프롬프트 수정을 공유 가능하고 감사 가능한 인텔리전스로 전환하는 생태계.

키워드: 프로토콜 제약 진화, 감사 추적, Gene과 Capsule, 프롬프트 거버넌스.

## 설치 경로 선택

Evolver는 하나의 설치 방법에 두 가지 사용 형태가 있습니다. 먼저 자신에게 맞는 경로를 선택하고, 해당 섹션만 읽으세요.

| 경로 | 대상 | 설치 후 명령어 | 가이드 |
|---|---|---|---|
| **CLI 빠른 시작** | Evolver로 에이전트/프로젝트를 진화시키려는 일반 사용자. 99%의 독자가 해당합니다. | `evolver` | [아래](#cli-빠른-시작) |
| **소스에서 실행** | 엔진 자체를 수정하거나, PR을 보내거나, 미릴리스 빌드를 실행하려는 기여자. | `node index.js` | [아래](#소스에서-실행기여자-전용) |

> **에이전트 / 스킬 통합** (Codex, Claude Code 스킬 시스템, 커스텀 MCP 클라이언트)은 별도 문서 [SKILL.md](SKILL.md)를 참조하세요. CLI를 래핑하는 Proxy mailbox API를 문서화하고 있습니다. 먼저 아래 CLI 빠른 시작으로 Evolver를 설치해야 합니다.

## 설치

### 사전 요구 사항

- **[Node.js](https://nodejs.org/)** >= 18
- **[Git](https://git-scm.com/)** -- 필수. Evolver는 롤백, 변경 범위 계산, solidify에 git을 사용합니다. git 저장소가 아닌 디렉터리에서 실행하면 명확한 오류 메시지와 함께 실패합니다.

### npm에서 설치 (권장)

```bash
npm install -g @evomap/evolver
```

`evolver` CLI가 전역으로 설치됩니다. `evolver --help`로 확인하세요.

Linux/macOS에서 `EACCES` 오류가 발생하면, `sudo` 대신 사용자 수준 prefix를 설정하세요:

```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### 플랫폼 통합

Evolver는 `setup-hooks`로 주요 에이전트 런타임과 통합할 수 있습니다. 통합하려는 플랫폼마다 한 번 실행하면 됩니다.

#### Cursor

```bash
evolver setup-hooks --platform=cursor
```

`~/.cursor/hooks.json`에 기록하고 `~/.cursor/hooks/`에 hook 스크립트를 배치합니다. Cursor를 재시작하거나 새 세션을 열면 적용됩니다. Hook은 `sessionStart`, `afterFileEdit`, `stop` 시 실행됩니다.

#### Claude Code

```bash
evolver setup-hooks --platform=claude-code
```

`~/.claude/`를 통해 Claude Code의 hook 시스템에 Evolver를 등록합니다. 설치 후 Claude Code CLI를 재시작하세요.

#### OpenClaw

OpenClaw는 Evolver가 stdout으로 출력하는 `sessions_spawn(...)` 프로토콜을 해석하므로 **hook 설치가 불필요**합니다. Evolver를 OpenClaw 워크스페이스에 클론하고 세션 내에서 실행하세요:

```bash
cd <your-openclaw-workspace>
git clone https://github.com/EvoMap/evolver.git
cd evolver
npm install
```

OpenClaw 세션 내에서 Evolver가 실행되면, 호스트가 stdout 지시문(`sessions_spawn(...)` 등)을 감지하여 후속 작업을 자동으로 연쇄 실행합니다.

### 소스에서 실행(기여자 전용)

`npm install -g @evomap/evolver`로 이미 설치한 경우 이 섹션을 완전히 건너뛰세요. 소스 실행 경로는 엔진 자체를 수정하려는 기여자만을 위한 것입니다.

```bash
git clone https://github.com/EvoMap/evolver.git
cd evolver
npm install

# 이후 문서의 모든 `evolver <flag>`는 `node index.js <flag>`로 대체 가능하며, 동작은 동일합니다
node index.js            # evolver와 동일
node index.js --review   # evolver --review와 동일
node index.js --loop     # evolver --loop과 동일
```

### EvoMap 네트워크 연결 (선택 사항)

[EvoMap 네트워크](https://evomap.ai)에 연결하려면, **`evolver`를 실행하는 현재 디렉터리**(홈 디렉터리나 전역 npm 설치 경로가 아님)에 `.env` 파일을 생성합니다. Evolver는 매 실행 시 `process.cwd()`에서 `.env`를 읽으므로, 프로젝트마다 별도의 `.env`를 둘 수 있습니다:

```bash
# Node ID를 받으려면 https://evomap.ai에서 등록하세요
A2A_HUB_URL=https://evomap.ai
A2A_NODE_ID=your_node_id_here
```

> **참고**: `.env` 없이도 모든 로컬 기능이 정상 작동합니다. Hub 연결은 스킬 공유, 워커 풀, 진화 리더보드 등 네트워크 기능에만 필요합니다.

## 빠른 시작

```bash
# 단일 진화 실행 -- 로그 스캔, Gene 선택, GEP 프롬프트 출력
evolver

# 리뷰 모드 -- 적용 전 일시 정지, 사람의 확인을 대기
evolver --review

# 연속 루프 -- 백그라운드 데몬으로 실행
evolver --loop
```

## Evolver가 하는 일과 하지 않는 일

**Evolver는 프롬프트 생성기이지, 코드 패처가 아닙니다.** 각 진화 사이클에서:

1. `memory/` 디렉터리에서 런타임 로그, 오류 패턴, 시그널을 스캔합니다.
2. `assets/gep/`에서 가장 적합한 [Gene 또는 Capsule](https://evomap.ai/wiki)을 선택합니다.
3. 다음 진화 단계를 안내하는 엄격한 프로토콜 기반 GEP 프롬프트를 출력합니다.
4. 추적을 위한 감사 가능한 [EvolutionEvent](https://evomap.ai/wiki)를 기록합니다.

**다음은 수행하지 않습니다**:
- 소스 코드를 자동으로 편집.
- 임의의 셸 명령어를 실행 ([보안 모델](#보안-모델) 참조).
- 핵심 기능에 인터넷 연결을 요구.

### 호스트 런타임과의 통합 방식

호스트 런타임(예: [OpenClaw](https://openclaw.com)) 내에서 실행될 때, stdout으로 출력되는 `sessions_spawn(...)` 텍스트는 후속 작업을 트리거하기 위해 호스트가 처리합니다. **스탠드얼론 모드에서는 단순한 텍스트 출력**이며, 자동으로 실행되는 것은 없습니다.

| 모드 | 동작 |
| :--- | :--- |
| 스탠드얼론 (`evolver`) | 프롬프트를 생성하고, stdout으로 출력한 뒤, 종료 |
| 루프 (`evolver --loop`) | 적응형 슬립이 포함된 데몬 루프에서 위 과정을 반복 |
| OpenClaw 내부 | 호스트 런타임이 `sessions_spawn(...)` 등 stdout 지시문을 해석 |

> **`--loop`은 "실행 중인 에이전트를 실시간으로 보조하는" 모드가 아닙니다.** 루프 모드는 백그라운드 자가 유지보수(validator 실행, worker 작업, ATP 상인 자동 배달, solidify)를 위한 것이며, 그 stdout은 evolver 자신이 소비합니다. 따라서 OpenClaw / Cursor / Claude Code가 설치되어 있더라도, 루프 모드에서 출력되는 `sessions_spawn(...)` 지시문은 이 호스트들에 전달되지 않습니다. 라이브 세션을 evolver가 관찰·보조하게 하려면, 해당 에이전트 세션 **내부에서** `evolver run`을 호출하세요(OpenClaw는 그 단일 실행의 stdout 지시문을 처리합니다). OpenClaw 사용자는 추가로, `AGENT_NAME`(또는 `AGENT_SESSIONS_DIR`)이 실제로 세션을 생성하는 에이전트 디렉터리(`~/.openclaw/agents/<이름>/sessions/`)를 가리키는지 확인하세요 -- 그렇지 않으면 evolver는 자신의 로그로 폴백하며, "빈 사이클만 돌고 있는" 것처럼 보입니다.

## 대상 사용자

**적합한 경우**
- 에이전트 프롬프트와 로그를 대규모로 유지보수하는 팀
- 감사 가능한 진화 추적([Genes](https://evomap.ai/wiki), [Capsules](https://evomap.ai/wiki), [Events](https://evomap.ai/wiki))이 필요한 사용자
- 결정론적이고 프로토콜 기반의 변경을 요구하는 환경

**적합하지 않은 경우**
- 로그나 이력이 없는 일회성 스크립트
- 자유로운 형식의 창의적 변경이 필요한 프로젝트
- 프로토콜 오버헤드를 수용할 수 없는 시스템

## 기능

- **자동 로그 분석**: 메모리 및 이력 파일을 스캔하여 오류 패턴을 감지.
- **자기 수복 가이드**: 시그널로부터 수복 중심의 지시문을 생성.
- **[GEP 프로토콜](https://evomap.ai/wiki)**: 재사용 가능한 에셋을 통한 표준화된 진화.
- **Mutation + Personality 진화**: 각 진화 실행은 명시적인 Mutation 객체와 진화 가능한 PersonalityState로 게이트.
- **설정 가능한 전략 프리셋**: `EVOLVE_STRATEGY=balanced|innovate|harden|repair-only`로 의도 밸런스를 제어.
- **시그널 중복 제거**: 정체 패턴을 감지하여 수복 루프를 방지.
- **운영 모듈** (`src/ops/`): 포터블한 라이프사이클, 스킬 모니터링, 클린업, 자기 수복, 웨이크 트리거 -- 제로 플랫폼 의존.
- **보호된 소스 파일**: 자율 에이전트가 코어 evolver 코드를 덮어쓰는 것을 방지.
- **[Skill Store](https://evomap.ai)**: `evolver fetch --skill <id>`로 재사용 가능한 스킬을 다운로드 및 공유.

## 주요 사용 사례

- 편집 전 검증을 강제하여 불안정한 에이전트 루프를 강화
- 반복되는 수정 사항을 재사용 가능한 [Gene과 Capsule](https://evomap.ai/wiki)로 인코딩
- 리뷰 또는 컴플라이언스를 위한 감사 가능한 진화 이벤트 생성

## 안티패턴

- 시그널이나 제약 없이 서브시스템 전체를 재작성
- 프로토콜을 범용 태스크 러너로 사용
- EvolutionEvent를 기록하지 않고 변경을 생성

## 사용법

### 표준 실행 (자동화)
```bash
evolver
```

### 리뷰 모드 (Human-in-the-Loop)
```bash
evolver --review
```

### 연속 루프
```bash
evolver --loop
```

### 전략 프리셋 지정
```bash
EVOLVE_STRATEGY=innovate evolver --loop   # 새 기능을 극대화
EVOLVE_STRATEGY=harden evolver --loop     # 안정성에 집중
EVOLVE_STRATEGY=repair-only evolver --loop # 긴급 수복 모드
```

| 전략 | Innovate | Optimize | Repair | 사용 시점 |
| :--- | :--- | :--- | :--- | :--- |
| `balanced` (기본값) | 50% | 30% | 20% | 일상 운영, 꾸준한 성장 |
| `innovate` | 80% | 15% | 5% | 시스템 안정 상태, 새 기능을 빠르게 출시 |
| `harden` | 20% | 40% | 40% | 대규모 변경 후, 안정성에 집중 |
| `repair-only` | 0% | 20% | 80% | 긴급 상태, 전력 수복 |

### 운영 (라이프사이클 관리)
```bash
node src/ops/lifecycle.js start    # 백그라운드에서 evolver 루프 시작
node src/ops/lifecycle.js stop     # 그레이스풀 중지 (SIGTERM -> SIGKILL)
node src/ops/lifecycle.js status   # 실행 상태 확인
node src/ops/lifecycle.js check    # 헬스 체크 + 정체 시 자동 재시작
```

### Skill Store
```bash
# EvoMap 네트워크에서 스킬 다운로드
evolver fetch --skill <skill_id>

# 출력 디렉터리 지정
evolver fetch --skill <skill_id> --out=./my-skills/
```

`A2A_HUB_URL` 설정이 필요합니다. 사용 가능한 스킬은 [evomap.ai](https://evomap.ai)에서 확인하세요.

### Cron / 외부 러너 Keepalive

cron이나 에이전트 러너에서 주기적으로 keepalive/tick을 실행하는 경우, 인용 부호를 최소화한 단순 명령어를 권장합니다.

권장:

```bash
bash -lc 'evolver --loop'
```

cron payload 내에서 여러 셸 세그먼트를 조합하는 것(예: `...; echo EXIT:$?`)은 피하세요. 중첩된 인용 부호가 여러 직렬화/이스케이프 레이어를 통과하면서 깨질 수 있습니다.

pm2 같은 프로세스 매니저에도 동일한 원칙이 적용됩니다 -- 명령어를 단순하게 래핑하세요:

```bash
pm2 start "bash -lc 'evolver --loop'" --name evolver --cron-restart="0 */6 * * *"
```

## EvoMap Hub 연결

Evolver는 네트워크 기능을 위해 [EvoMap Hub](https://evomap.ai)에 선택적으로 연결할 수 있습니다. 핵심 진화 기능에는 **필요하지 않습니다**.

### 설정

1. [evomap.ai](https://evomap.ai)에서 등록하고 Node ID를 발급받습니다.
2. `.env` 파일에 다음을 추가합니다:

```bash
A2A_HUB_URL=https://evomap.ai
A2A_NODE_ID=your_node_id_here
```

### Hub 연결로 활성화되는 기능

| 기능 | 설명 |
| :--- | :--- |
| **하트비트** | Hub와 주기적으로 체크인하여 노드 상태를 보고하고 가용 작업을 수신 |
| **Skill Store** | 재사용 가능한 스킬 다운로드 및 게시 (`evolver fetch`) |
| **워커 풀** | 네트워크에서 진화 작업을 수신하고 실행 ([워커 풀](#워커-풀-evomap-네트워크) 참조) |
| **진화 서클** | 공유 컨텍스트를 가진 협업 진화 그룹 |
| **에셋 게시** | Gene과 Capsule을 네트워크에 공유 |

### 작동 방식

Hub가 설정된 상태에서 `evolver --loop`를 실행하면:

1. 시작 시, evolver는 Hub에 등록하기 위해 `hello` 메시지를 전송합니다.
2. 하트비트는 6분마다 전송됩니다(`HEARTBEAT_INTERVAL_MS`로 설정 가능).
3. Hub는 가용 작업, 기한 초과 작업 알림, 스킬 스토어 힌트를 응답합니다.
4. `WORKER_ENABLED=1`인 경우, 노드는 자신의 역량을 광고하고 작업을 수령합니다.

Hub 설정 없이 evolver는 완전히 오프라인으로 실행됩니다 -- 모든 핵심 진화 기능은 로컬에서 동작합니다.

## 워커 풀 (EvoMap 네트워크)

`WORKER_ENABLED=1`인 경우, 이 노드는 [EvoMap 네트워크](https://evomap.ai)의 워커로 참여합니다. 하트비트를 통해 역량을 광고하고, 네트워크의 가용 작업 큐에서 작업을 수령합니다. 작업은 성공적인 진화 사이클 후 solidify 단계에서 원자적으로 클레임됩니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `WORKER_ENABLED` | _(미설정)_ | `1`로 설정하여 워커 풀 모드 활성화 |
| `WORKER_DOMAINS` | _(비어 있음)_ | 이 워커가 수락하는 작업 도메인의 쉼표 구분 목록 (예: `repair,harden`) |
| `WORKER_MAX_LOAD` | `5` | Hub 측 스케줄링용으로 광고되는 최대 동시 작업 용량 (로컬에서 강제하는 동시성 제한이 아님) |

```bash
WORKER_ENABLED=1 WORKER_DOMAINS=repair,harden WORKER_MAX_LOAD=3 evolver --loop
```

### WORKER_ENABLED와 웹사이트 토글

[evomap.ai](https://evomap.ai) 대시보드의 노드 상세 페이지에 "Worker" 토글이 있습니다. 두 가지의 관계는 다음과 같습니다:

| 제어 | 범위 | 동작 |
| :--- | :--- | :--- |
| `WORKER_ENABLED=1` (환경 변수) | **로컬** | 로컬 evolver 데몬에 하트비트에 워커 메타데이터를 포함하고 작업을 수락하도록 지시 |
| 웹사이트 토글 | **Hub 측** | Hub에 이 노드로 작업을 디스패치할지 여부를 지시 |

노드가 네트워크에서 작업을 수신하고 실행하려면 **양쪽 모두 활성화**되어야 합니다. 어느 한쪽이라도 비활성화되면 노드는 네트워크에서 작업을 수령하지 않습니다. 권장 흐름:

1. `.env`에 `WORKER_ENABLED=1`을 설정하고 `evolver --loop`을 시작합니다.
2. [evomap.ai](https://evomap.ai)에서 자신의 노드를 찾아 Worker 토글을 켭니다.

## GEP 프로토콜 (감사 가능한 진화)

이 저장소에는 [GEP (Genome Evolution Protocol)](https://evomap.ai/wiki) 기반의 프로토콜 제약 프롬프트 모드가 포함되어 있습니다.

- **구조화된 에셋**은 `assets/gep/`에 위치합니다:
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **Selector** 로직은 추출된 시그널을 사용하여 기존 Gene/Capsule을 우선하며, 프롬프트에 JSON selector 결정을 출력합니다.
- **제약**: 문서에서 허용되는 이모지는 DNA 이모지만 해당됩니다. 그 외 모든 이모지는 금지됩니다.

## 설정과 분리

Evolver는 **환경에 구애받지 않도록** 설계되었습니다.

### 핵심 환경 변수

| 변수 | 설명 | 기본값 |
| :--- | :--- | :--- |
| `EVOLVE_STRATEGY` | 진화 전략 프리셋 (`balanced` / `innovate` / `harden` / `repair-only`) | `balanced` |
| `A2A_HUB_URL` | [EvoMap Hub](https://evomap.ai) URL | _(미설정, 오프라인 모드)_ |
| `A2A_NODE_ID` | 네트워크에서의 노드 아이덴티티 | _(디바이스 핑거프린트로 자동 생성)_ |
| `HEARTBEAT_INTERVAL_MS` | Hub 하트비트 간격 | `360000` (6분) |
| `MEMORY_DIR` | 메모리 파일 경로 | `./memory` |
| `EVOLVE_REPORT_TOOL` | 결과 보고용 도구 이름 | `message` |

### 로컬 오버라이드 (주입)
코어 코드를 수정하지 않고 로컬 설정을 주입할 수 있습니다(예: 보고에 `message` 대신 `feishu-card` 사용).

**방법 1: 환경 변수**
`.env` 파일에 `EVOLVE_REPORT_TOOL`을 설정:
```bash
EVOLVE_REPORT_TOOL=feishu-card
```

**방법 2: 동적 감지**
스크립트는 호환되는 로컬 스킬(예: `skills/feishu-card`)이 워크스페이스에 존재하는지 자동으로 감지하고, 그에 따라 동작을 업그레이드합니다.

### 검증자 역할 (기본 ON)

[EvoMap Hub](https://evomap.ai)에 연결되면, 각 evolver 인스턴스는 **분산 검증자**로도 동작합니다: Hub가 할당한 검증 작업을 주기적으로 가져와서, 제안자가 선언한 검증 명령어를 샌드박스에서 실행하고, `ValidationReport`를 반환합니다. 합의에 참여한 검증자는 크레딧과 평판을 획득합니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `EVOLVER_VALIDATOR_ENABLED` | _(미설정 = ON)_ | `0`/`false`/`off`로 옵트아웃; `1`/`true`/`on`으로 강제 ON. env가 Hub 푸시 플래그와 코드 기본값보다 우선합니다. |
| `EVOLVER_VALIDATOR_DAEMON_INTERVAL_MS` | `60000` | `--loop`/`--mad-dog` 모드에서 검증자 데몬 폴링 간격. |
| `EVOLVER_VALIDATOR_MAX_TASKS_PER_CYCLE` | `2` | 폴링당 최대 클레임 작업 수. |
| `EVOLVER_VALIDATOR_FETCH_TIMEOUT_MS` | `8000` | 1회 가져오기 타임아웃. |

영구 플래그 오버라이드: env가 미설정이면, 런타임은 `~/.evomap/feature_flags.json`을 읽습니다. Hub는 기존 mailbox 채널을 통해 `feature_flag_update` 이벤트를 보내 업그레이드 후 레거시 노드를 자동 ON 할 수 있습니다.

영구적으로 옵트아웃:

```bash
EVOLVER_VALIDATOR_ENABLED=0 evolver run --loop
```

### 자동 GitHub Issue 보고

evolver가 지속적인 실패(실패 루프 또는 높은 실패율의 반복 오류)를 감지하면, 정제된 환경 정보와 로그로 GitHub issue를 업스트림 저장소에 자동 제출할 수 있습니다. 모든 민감한 데이터(토큰, 로컬 경로, 이메일 등)는 제출 전에 `[REDACTED]`로 치환됩니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `EVOLVER_AUTO_ISSUE` | `true` | 자동 issue 보고 활성화/비활성화 |
| `EVOLVER_ISSUE_REPO` | `autogame-17/capability-evolver` | 대상 GitHub 저장소 (owner/repo) |
| `EVOLVER_ISSUE_COOLDOWN_MS` | `86400000` (24시간) | 동일 오류 시그니처의 쿨다운 기간 |
| `EVOLVER_ISSUE_MIN_STREAK` | `5` | 보고를 트리거하는 최소 연속 실패 횟수 |

`repo` 스코프가 있는 `GITHUB_TOKEN`(또는 `GH_TOKEN` / `GITHUB_PAT`)이 필요합니다. 토큰이 없으면 이 기능은 조용히 건너뜁니다.

## 보안 모델

이 섹션에서는 Evolver의 실행 경계와 신뢰 모델을 설명합니다.

### 무엇이 실행되고 무엇이 실행되지 않는가

| 컴포넌트 | 동작 | 셸 명령어 실행 여부 |
| :--- | :--- | :--- |
| `src/evolve.js` | 로그 읽기, Gene 선택, 프롬프트 구축, 아티팩트 기록 | 읽기 전용 git/프로세스 쿼리만 |
| `src/gep/prompt.js` | GEP 프로토콜 프롬프트 문자열 조립 | 아니오 (순수 텍스트 생성) |
| `src/gep/selector.js` | 시그널 매칭으로 Gene/Capsule 스코어링 및 선택 | 아니오 (순수 로직) |
| `src/gep/solidify.js` | Gene의 `validation` 명령어를 통해 패치 검증 | 예 (아래 참조) |
| `index.js` (루프 복구) | 크래시 시 `sessions_spawn(...)` 텍스트를 stdout에 출력 | 아니오 (텍스트 출력만; 실행 여부는 호스트 런타임에 의존) |

### Gene Validation 명령어 안전성

`solidify.js`는 Gene의 `validation` 배열에 나열된 명령어를 실행합니다. 임의 명령어 실행을 방지하기 위해, 모든 validation 명령어는 안전성 검사(`isValidationCommandAllowed`)를 통과해야 합니다:

1. **접두사 화이트리스트**: `node`, `npm`, `npx`로 시작하는 명령어만 허용.
2. **명령어 치환 금지**: 백틱과 `$(...)`는 명령어 문자열 어디에서든 거부.
3. **셸 연산자 금지**: 인용된 내용을 제거한 후, `;`, `&`, `|`, `>`, `<`는 거부.
4. **타임아웃**: 각 명령어는 180초로 제한.
5. **스코프 실행**: 명령어는 `cwd`를 저장소 루트로 설정하여 실행.

### A2A 외부 에셋 인제스트

`scripts/a2a_ingest.js`를 통해 인제스트된 외부 Gene/Capsule 에셋은 격리된 후보 영역에 스테이징됩니다. 로컬 스토어(`scripts/a2a_promote.js`)로의 승격에는 다음이 필요합니다:

1. 명시적인 `--validated` 플래그 (운영자가 먼저 에셋을 검증해야 함).
2. Gene의 경우: 모든 `validation` 명령어가 승격 전 동일한 안전성 검사에 대해 감사됨. 안전하지 않은 명령어는 승격을 거부.
3. Gene 승격은 동일 ID의 기존 로컬 Gene을 절대 덮어쓰지 않음.

### `sessions_spawn` 출력

`index.js`와 `evolve.js`의 `sessions_spawn(...)` 문자열은 직접적인 함수 호출이 아닌 **stdout으로의 텍스트 출력**입니다. 이것이 해석되는지 여부는 호스트 런타임(예: OpenClaw 플랫폼)에 따라 다릅니다. evolver 자체는 `sessions_spawn`을 실행 가능한 코드로 호출하지 않습니다.

## 공개 릴리스

이 저장소는 공개 배포판입니다.

- 공개용 빌드: `npm run build`
- 공개용 게시: `npm run publish:public`
- 드라이런: `DRY_RUN=true npm run publish:public`

필수 환경 변수:

- `PUBLIC_REMOTE` (기본값: `public`)
- `PUBLIC_REPO` (예: `EvoMap/evolver`)
- `PUBLIC_OUT_DIR` (기본값: `dist-public`)
- `PUBLIC_USE_BUILD_OUTPUT` (기본값: `true`)

선택 환경 변수:

- `SOURCE_BRANCH` (기본값: `main`)
- `PUBLIC_BRANCH` (기본값: `main`)
- `RELEASE_TAG` (예: `v1.0.41`)
- `RELEASE_TITLE` (예: `v1.0.41 - GEP protocol`)
- `RELEASE_NOTES` 또는 `RELEASE_NOTES_FILE`
- GitHub Release 생성용 `GITHUB_TOKEN` (또는 `GH_TOKEN` / `GITHUB_PAT`)
- `RELEASE_SKIP` (`true`로 설정하면 GitHub Release 생성을 건너뜀; 기본값은 생성)
- `RELEASE_USE_GH` (`true`로 설정하면 GitHub API 대신 `gh` CLI 사용)
- `PUBLIC_RELEASE_ONLY` (`true`로 설정하면 기존 태그에 대해 Release만 생성; 코드 게시 없음)

## 버전 관리 (SemVer)

MAJOR.MINOR.PATCH

- MAJOR: 호환되지 않는 변경
- MINOR: 하위 호환되는 기능 추가
- PATCH: 하위 호환되는 버그 수정

## 변경 이력

전체 릴리스 이력은 [GitHub Releases](https://github.com/EvoMap/evolver/releases)에서 확인하세요.

## FAQ

**코드를 자동으로 수정하나요?**
아닙니다. Evolver는 진화를 안내하는 프로토콜 기반 프롬프트와 에셋을 생성합니다. 소스 코드를 직접 수정하지 않습니다. [Evolver가 하는 일과 하지 않는 일](#evolver가-하는-일과-하지-않는-일)을 참조하세요.

**`evolver --loop`을 실행했는데 텍스트만 계속 출력됩니다. 정상인가요?**
네. 스탠드얼론 모드에서 evolver는 GEP 프롬프트를 생성하고 stdout으로 출력합니다. 변경 사항이 자동으로 적용되길 기대했다면, 출력을 해석하는 [OpenClaw](https://openclaw.com)와 같은 호스트 런타임이 필요합니다. 또는 `--review` 모드를 사용하여 각 진화 단계를 수동으로 리뷰하고 적용할 수 있습니다.

**EvoMap Hub에 연결해야 하나요?**
아닙니다. 모든 핵심 진화 기능은 오프라인으로 동작합니다. Hub 연결은 스킬 스토어, 워커 풀, 진화 리더보드 등 네트워크 기능에만 필요합니다. [EvoMap Hub 연결](#evomap-hub-연결)을 참조하세요.

**모든 GEP 에셋을 사용해야 하나요?**
아닙니다. 기본 Gene으로 시작하여 시간이 지남에 따라 확장할 수 있습니다.

**프로덕션 환경에서 안전한가요?**
리뷰 모드와 검증 단계를 사용하세요. 라이브 패처가 아닌, 안전성 중심의 진화 도구로 취급하세요. [보안 모델](#보안-모델)을 참조하세요.

**저장소를 어디에 클론해야 하나요?**
아무 디렉터리나 가능합니다. [OpenClaw](https://openclaw.com)를 사용한다면 호스트 런타임이 evolver의 stdout에 접근할 수 있도록 OpenClaw 워크스페이스에 클론하세요. 스탠드얼론 사용 시 어디든 상관없습니다.

## 로드맵

- 1분 데모 워크플로 추가
- 대안과의 비교 표 추가

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=EvoMap/evolver&type=Date)](https://star-history.com/#EvoMap/evolver&Date)

## 감사의 말

- [onthebigtree](https://github.com/onthebigtree) -- evomap 진화 네트워크 탄생에 영감을 주었습니다. 3개의 런타임 및 로직 버그를 수정 (PR [#25](https://github.com/EvoMap/evolver/pull/25)); 호스트명 프라이버시 해싱, 포터블 검증 경로, 데드 코드 클린업에 기여 (PR [#26](https://github.com/EvoMap/evolver/pull/26)).
- [lichunr](https://github.com/lichunr) -- 컴퓨트 네트워크가 무료로 사용할 수 있도록 수천 달러 상당의 토큰을 제공.
- [shinjiyu](https://github.com/shinjiyu) -- 다수의 버그 리포트를 제출하고, 스니펫이 포함된 태그를 가진 다국어 시그널 추출에 기여 (PR [#112](https://github.com/EvoMap/evolver/pull/112)).
- [voidborne-d](https://github.com/voidborne-d) -- 11개의 새로운 크리덴셜 탐지 패턴으로 브로드캐스트 전 정제를 강화 (PR [#107](https://github.com/EvoMap/evolver/pull/107)); strategy, validationReport, envFingerprint를 위한 45개의 테스트 추가 (PR [#139](https://github.com/EvoMap/evolver/pull/139)).
- [blackdogcat](https://github.com/blackdogcat) -- 누락된 dotenv 의존성을 수정하고 인텔리전트 CPU 부하 임계값 자동 계산을 구현 (PR [#144](https://github.com/EvoMap/evolver/pull/144)).
- [LKCY33](https://github.com/LKCY33) -- .env 로딩 경로와 디렉터리 권한을 수정 (PR [#21](https://github.com/EvoMap/evolver/pull/21)).
- [hendrixAIDev](https://github.com/hendrixAIDev) -- 드라이런 모드에서 performMaintenance()가 실행되는 문제를 수정 (PR [#68](https://github.com/EvoMap/evolver/pull/68)).
- [toller892](https://github.com/toller892) -- events.jsonl forbidden_paths 버그를 독립적으로 발견하고 보고 (PR [#149](https://github.com/EvoMap/evolver/pull/149)).
- [WeZZard](https://github.com/WeZZard) -- SKILL.md에 A2A_NODE_ID 설정 가이드를 추가하고, NODE_ID가 명시적으로 설정되지 않은 경우 a2aProtocol에서 콘솔 경고를 추가 (PR [#164](https://github.com/EvoMap/evolver/pull/164)).
- [Golden-Koi](https://github.com/Golden-Koi) -- README에 cron/외부 러너 keepalive 모범 사례를 추가 (PR [#167](https://github.com/EvoMap/evolver/pull/167)).
- [upbit](https://github.com/upbit) -- evolver 및 evomap 기술의 보급에 핵심적인 역할.
- [Chi Jianqiang](https://mowen.cn) -- 홍보와 사용자 경험 개선에 큰 기여.

## 라이선스

[GPL-3.0-or-later](https://opensource.org/licenses/GPL-3.0)

> 핵심 진화 엔진 모듈은 지적 재산권 보호를 위해 난독화된 형태로 배포됩니다. 소스: [EvoMap/evolver](https://github.com/EvoMap/evolver).
