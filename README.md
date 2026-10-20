# Quiet solitaire experimental Web build

앱 프로젝트의 브라우저 실험을 위한 별도 배포 저장소입니다. 정식 웹 출시를 위한 제품 분기가 아닙니다.
게임 소스는 Private인 `neuma573/quiet-solitaire`에만 보관하고, 여기에는 Web Export 설정과 CI/CD만 관리합니다.

배포 주소: **https://neuma573.com/quiet-solitaire-web/**
https://neuma573.github.io/quiet-solitaire-web/ 는 계정의 기존 도메인으로 이동합니다.
이 실험용 Pages에만 HTTPS를 적용했고 다른 저장소의 도메인 설정은 변경하지 않았습니다.

## 자동 배포

```mermaid
flowchart LR
    A[Private 앱 저장소 main PR 머지] -->|GitHub Webhook| W[Cloudflare Worker · 서명 검증]
    W -->|repository_dispatch · 머지 SHA| B[웹 저장소 GitHub Actions]
    B --> C[읽기 전용 · 정확한 SHA의 임시 Checkout]
    C --> D[Godot 4.7.2 · 전체 테스트]
    D --> E[단일 스레드 Web Export]
    E --> F[PCK 공개 범위 검사 · Chromium 실행 검사]
    F --> G[GitHub Pages]
```

- 원본의 `pull_request` Webhook 중 `closed`, `merged: true`, 대상 브랜치 `main`인 이벤트만 배포를 시작합니다. 주기적인 확인은 없습니다. main 직접 push는 이 실험의 자동 배포 대상이 아닙니다.
- Worker는 원문 요청의 `X-Hub-Signature-256`을 HMAC-SHA256으로 검증하고 원본 저장소 ID·이름·Private 여부와 머지 SHA를 확인합니다. 잘못된 서명, 다른 저장소와 미머지 이벤트로는 Actions를 호출하지 않습니다.
- Worker가 `source-main-merged` dispatch에 `merge_commit_sha`를 전달합니다. 원본 Webhook에는 Private PR 정보가 있지만 Public Actions에는 저장소 식별자·SHA·delivery ID만 전달합니다. Worker 요청 로그는 활성화하지 않습니다.
- 게시된 원본 SHA와 파이프라인 SHA가 같으면 다운로드·빌드·배포를 건너뜁니다.
- 확인한 40자리 SHA로 checkout합니다. 빌드 중 main이 바뀌면 오래된 결과는 게시하지 않습니다.
- 원본 공식 명령 `python3 scripts/test.py`의 전체 테스트, Web Export, PCK 공개 범위 검사와 실제 Chromium 검사를 통과한 결과만 게시합니다.
- 실패한 빌드는 게시 단계에 도달하지 않아 기존 사이트를 유지합니다. Pages 게시 실패도 기존 게시본을 교체하지 않습니다. 게시 후 HTTP 확인 실패와 게시 자체의 실패는 별도로 판단해야 합니다.
- `Actions → Deploy experimental Web build → Run workflow`로 즉시 확인할 수 있습니다. 선택적인 `source_sha`도 현재 main과 일치해야 게시됩니다.
- 웹 설정이 main에 바뀌면 재검증합니다. PR 검사는 원본 접근·게시 권한을 사용하지 않습니다.
- Worker를 수정한 경우 테스트 후 `npx wrangler deploy`로 별도 게시합니다. GitHub Pages 빌드에는 Cloudflare 인증이 필요하지 않습니다.

## 원본과 보안

원본에서 변경하는 것은 `quiet-solitaire`로의 저장소 이름 정리, 읽기 전용 Deploy Key와 Webhook 설정뿐입니다.
게임 코드, 기존 설정 파일, 브랜치, 커밋·태그 이력에 웹용 변경을 추가하지 않습니다.

| 인증 정보 | 저장 위치 | 범위 |
| --- | --- | --- |
| `SOURCE_DEPLOY_KEY` | 웹 저장소 Actions Secret | 원본 저장소 한 개의 Git 읽기 전용 |
| `WEBHOOK_SECRET` | Worker Secret 및 원본 Webhook 설정 | 이 Webhook의 HMAC 서명 검증 |
| `GITHUB_DISPATCH_TOKEN` | Worker Secret | Fine-grained PAT, 웹 저장소 한 개의 `Contents: Read and write` |
| 기본 `GITHUB_TOKEN` | Actions가 발급 | 빌드에서 Public 웹 저장소 `contents: read` |
| 배포 토큰/OIDC | Actions가 발급 | 별도 배포 job에서 `pages: write`, `id-token: write` |

SSH 호스트 키는 GitHub HTTPS API에서 받아 검증합니다. 개인 키는 해당 단계의 임시 경로에서 제거합니다.
원본 checkout은 runner 임시 경로에만 있으며, 게임 실행·테스트 단계에는 SSH 인증 정보를 전달하지 않습니다.
원본을 Public Git 이력이나 Actions cache에 올리지 않습니다. private 로그와 테스트 보고서는 runner에만 남으며 업로드하지 않습니다.
Pages artifact에는 공개 런타임 파일만 포함하고 보존 기간은 1일입니다.

WebAssembly·`.pck`·이미지·컴파일된 GDScript는 플레이에 필요한 공개 런타임입니다.
`.pck`는 다운로드·분석할 수 있으므로 웹 배포로 구현의 역분석까지 막을 수는 없습니다.
게시 전 파일 목록 검사로 원본 `.gd`, 테스트, 문서, 네이티브 플러그인과 개발 인증 파일의 포함을 거부합니다.
게임에는 서버 토큰이나 API 키를 넣지 않습니다.

## Webhook 연결과 복구

`wrangler.jsonc`와 `worker/index.mjs`에 수신기를 관리합니다. 브라우저 로그인은 다음 범위만 요청합니다.

수신 URL: `https://quiet-solitaire-web-webhook.quiet-solitaire-web-deployment.workers.dev/github`

```sh
npx wrangler login --scopes account:read user:read workers_scripts:write
npx wrangler deploy
```

Worker의 `/health`는 두 Secret이 설정됐을 때만 200을 반환합니다. Secret은 Wrangler의 `secret put` 또는 `secret bulk`로 저장하고 설정 파일·Git에 기록하지 않습니다.
원본 Settings → Webhooks에는 Worker의 `/github` URL, `application/json`, SSL 검증 활성화, `Pull requests` 이벤트와 동일한 HMAC Secret을 설정합니다.
실제 배포된 Worker URL과 Cloudflare 계정은 `wrangler deploy` 출력에서 확인할 수 있습니다.

원본 저장소 이름을 변경하면 `worker/index.mjs`와 `scripts/source.py`의 `SOURCE`도 함께 맞춥니다.
GitHub의 이전 주소 리디렉션은 Webhook·dispatch 본문의 저장소 이름 검사에 적용되지 않습니다.
이 참조를 바꿀 때는 웹 저장소의 main 반영과 Worker 재배포를 모두 완료해야 자동 배포가 연결됩니다.

GitHub 토큰은 소유자 `neuma573`, 저장소 `quiet-solitaire-web` 한 개와 `Contents: Read and write`만 선택합니다. 원본 읽기 권한은 별도의 읽기 전용 Deploy Key에 한정합니다.
GitHub API가 dispatch를 거부하면 Worker는 502를 반환합니다. GitHub Webhook은 실패 delivery를 자동 재시도하지 않으므로 원본 Settings → Webhooks → Recent Deliveries에서 원인을 해결한 뒤 Redeliver하거나 웹 저장소의 수동 실행을 사용합니다.
이미 게시됐거나 현재 main보다 오래된 SHA는 다시 게시하지 않습니다.

## Web Export 호환성

- 원본 README, 설치 엔진과 공식 템플릿을 **Godot 4.7.2 stable**로 맞추고 공식 SHA256을 확인합니다. 원본 엔진 버전이 바뀌면 자동 배포를 중단하므로 `godot-version.json`을 검토해야 합니다.
- GDScript·GL Compatibility를 사용하며 WebAssembly·WebGL 2가 필요합니다. 스레드·GDExtension을 끕니다.
- 게임의 논리 화면은 원본의 기준인 **390×760**으로 고정합니다. PC에서는 중앙에 같은 크기로 표시하고, 더 작은 브라우저에서는 화면 전체의 표시 크기만 같은 비율로 줄입니다. 창 크기·화면 배율이 바뀌어도 카드·메뉴 배치는 바뀌지 않습니다. 고해상도 화면에서는 렌더링 픽셀 수만 화면 배율에 맞춥니다. 웹 전용 HTML shell과 export preset만 사용하며 원본 프로젝트 설정은 수정하지 않습니다.
- iOS 네이티브 설정·전환은 기존 Godot 폴백을 사용하고 Game Center는 사용할 수 없습니다. 네이티브 파일은 내보내지 않습니다.
- 깨끗한 checkout의 CSV 번역과 글꼴을 생성하기 위해 임시 복사본에서 번역 참조를 잠시 비우고 import합니다. 이후 번역 참조를 복원하고 웹 전용 테마를 적용한 상태로 원본의 공식 전체 테스트를 실행합니다. 같은 테마로 Web Export하며 원본 checkout과 게임 코드·번역·씬·테스트는 바꾸지 않습니다.
- `web/theme.tres`는 Arimo와 Noto Sans CJK를 묶고, Web의 `SystemFont`가 사용하는 기본 테마 글꼴도 지정합니다. Noto의 큰 기본 행 높이가 영어에도 적용되는 Godot 동작에 맞춰 `web/prepare_fonts.gd`에서 CJK의 행 상자를 1.25 em으로 설정하고, 일본어 버튼에는 글꼴의 비례 자간 기능 `palt`를 사용합니다. 글리프 크기와 다운로드한 폰트 데이터는 유지하며, 테스트의 최소 카드 공간 기준을 변경하지 않습니다.
- Linux 검증에서는 빌드별 Fontconfig 설정으로 번들 글꼴만 검색합니다. runner에 설치된 시스템 글꼴에 따라 레이아웃 결과가 달라지지 않게 하며 시스템 전체의 글꼴 설정은 바꾸지 않습니다. 웹 글꼴 설정은 회귀 테스트와 내보내기에 동일하게 적용합니다.
- 임시 복사본의 iOS export preset은 Web preset으로 대체합니다. 배포에는 행 높이를 설정한 CJK 리소스만 포함하며 준비에 사용한 원본 OTF를 중복으로 넣지 않습니다.
- 브라우저는 원본의 시스템 폰트를 제공하지 않아 웹 글꼴이 필요합니다. Arimo와 Noto는 `web/font.json`에 고정한 공식 커밋에서 다운로드하고 각각 SHA256을 검증합니다. 저작권 고지와 SIL OFL 1.1 전문은 배포물의 `FONT-LICENSE.txt`에 포함하며 원본에는 폰트를 추가하지 않습니다.
- 런타임 배치 JSON 두 개(`assets/deals/draw-1-decks.json`, `assets/deals/draw-3-decks.json`)는 Web preset에서 명시적으로 포함합니다. PCK 검사는 둘 중 하나라도 빠지거나 다른 JSON(개발용 해답 포함)이 들어가면 게시를 거부합니다.
- PWA·오프라인 캐시는 추가하지 않습니다. 원본과 동일하게 진행 중인 게임 재개 저장은 없으며 설정·통계 보존은 브라우저 IndexedDB 정책의 영향을 받습니다.
- Chromium에서 실제 실행을 확인합니다. iPhone Safari의 성능·터치·안전 영역, VoiceOver는 별도 실기기 검증 대상입니다.

## 독립 리더보드 페이지

`/quiet-solitaire-web/leaderboard/`는 게임 엔진을 불러오지 않는 가벼운 반응형 순위 페이지입니다.
데스크톱과 모바일에서 누적 XP 상위 25명의 순위·닉네임·XP를 표시합니다.
게임의 마이페이지 리더보드에는 별도 페이지를 새 탭으로 여는 링크가 있고,
순위 페이지에서는 상단의 **게임으로** 링크로 돌아갈 수 있습니다.

- 기존 `GET /v1/leaderboard?limit=25` 응답을 읽기만 하며, 게스트 생성·가입·닉네임 변경은 하지 않습니다.
- `web/leaderboard-config.json` 한 개를 게임과 공유합니다. `apiBase`가 비어 있으면
  실제 순위 대신 서버 연결 준비 안내를 표시하고 API를 호출하지 않습니다. 샘플 순위는 게시하지 않습니다.
- 불러오는 중·기록 없음·연결 오류·응답 시간 초과를 구분하며 오류 후 다시 시도할 수 있습니다.
- 공개 파일은 `scripts/build.py`의 명시적 허용 목록으로만 복사합니다.
  `web/leaderboard/`가 페이지이고, 저장소 루트의 `leaderboard/`는 비공개 배포용 서버 코드입니다.
- 순위는 기존 서버의 XP 내림차순과 동점 순서를 유지합니다. 스키마나 순서가 잘못된 응답은 표시하지 않습니다.
- 위 경로는 이 변경을 main에 반영하고 기존 배포 검사를 통과한 뒤 제공됩니다.

페이지·API 응답 테스트와 실제 Chromium 검사는 다음 명령으로 실행합니다.
브라우저 검사에 등장하는 순위는 가로챈 로컬 테스트 데이터이며 실제 순위가 아닙니다.

```sh
node --test tests/*.test.mjs
node tests/leaderboard-page-browser.mjs
# 전체 Godot 빌드 결과의 하위 경로와 자산 검사
node tests/leaderboard-page-browser.mjs --directory /path/to/export
```

## 웹 리더보드 (로컬 구현, 서버 연결 전)

리더보드는 **누적 XP 내림차순**이며 순위·닉네임·XP만 표시합니다. 서버가 랜덤 닉네임과
별도 고유 ID를 발급하므로 닉네임을 바꿔도 ID와 XP는 유지됩니다. 사용자가 참여한 뒤 새로
시작한 게임의 승리 XP만 서버에서 지급량을 계산해 누적하며, 기존 로컬 통계는 업로드하지 않습니다.

- `web/leaderboard_bridge.gd`는 웹 빌드의 임시 복사본에만 추가하는 관찰용 autoload입니다.
  원본 게임 코드와 커밋은 변경하지 않습니다. 기존 마이페이지의 웹 전용 버튼으로 리더보드를 열고 닉네임을 수정합니다.
  게임의 시간·이동 수 표시를 가리지 않도록 게임 shell에서는 별도의 떠 있는 실행 버튼을 숨깁니다.
- `leaderboard/`는 별도의 게임 API와 D1 스키마입니다. `worker/`와 루트 `wrangler.jsonc`의
  기존 GitHub 웹훅, 토큰, 배포 책임은 공유하지 않습니다.
- 기본 `web/leaderboard-config.json`의 `apiBase`는 비어 있어 공유 기능이 꺼져 있습니다.
  필요한 서버·DB·도메인·비밀값과 연결 절차는 [리더보드 설정 문서](leaderboard/README.md)를 참조하세요.
  이 구현은 외부 리소스를 만들거나 배포하지 않습니다.
- 게스트는 HttpOnly 쿠키로 인증합니다. 닉네임이나 클라이언트가 보낸 ID로 쓰기를 인증하지 않습니다.
  쿠키 삭제·브라우저 변경·다른 기기에서는 기존 ID와 XP를 복구할 수 없으며 로그인 기능은 없습니다.
- 서버의 지급량 계산·중복 지급 방지·기본 요청 제한은 포함하지만, 브라우저의 승리 보고 자체를
  증명하지는 않습니다. 결과는 클라이언트 신고 기록입니다. 상금이나 경쟁 대회의 검증 수단으로 사용할 수 없습니다.
- 게임 연결은 검토한 원본 SHA와 소스 계약을 확인하고 실패 시 빌드를 중단합니다. 원본 SHA가 바뀌면
  `web/leaderboard-compatibility.json`과 어댑터를 다시 검토해야 합니다.

실제 로컬 Workers/D1와 전체 원본 테스트·Web Export·PCK·1×/2× 실행 검사를 통과했습니다.
초기 WSL 메뉴 테스트 실패는 실행 파일·사용자 데이터·로그까지 Linux 네이티브 경로에 둔
환경에서 원본 수정 없이 해소됐습니다. 환경 비교와 재현 명령은 [검증 기록](leaderboard/VERIFICATION.md)에 기록했습니다.

추가 검증:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
# Playwright 설치 후 선택적으로 실행 (모든 HTTPS 요청을 로컬에서 가로채며 외부 통신 없음)
node tests/leaderboard-ui-browser.mjs
node tests/leaderboard-api-browser.mjs
# 실제 Web Export의 마이페이지 연결 검사
node tests/leaderboard-export-browser.mjs --directory /path/to/export
```

`GODOT_BIN`을 설정하면 Python 검증에 실제 Godot 어댑터 수명주기 검사도 포함됩니다.
브라우저 검사는 `CHROME_BIN`으로 설치된 Chromium 계열 브라우저를 지정할 수 있습니다.
API 브라우저 검사는 실제 핸들러와 SQLite를 사용하지만 Cloudflare 런타임·배포 검사를 대신하지는 않습니다.

## 로컬 빌드 검증

```sh
python3 -m unittest discover -s tests -v
node --test tests/worker.test.mjs
npm ci --ignore-scripts
npx wrangler deploy --dry-run --outdir /tmp/quiet-web-worker-check
npx playwright install chromium
```

원본을 별도 checkout하고 비어 있는 출력 경로를 지정합니다. 설치된 Godot와 Web export templates는 같은 4.7.2 버전이어야 합니다.

```sh
python3 scripts/build.py --source /path/to/private-checkout --output /tmp/quiet-web-site --godot /path/to/godot
node scripts/smoke.mjs --directory /tmp/quiet-web-site
node scripts/smoke.mjs --directory /tmp/quiet-web-site --locale ja-JP --screenshot /tmp/quiet-web-ja.png
node scripts/smoke.mjs --url https://neuma573.com/quiet-solitaire-web/
```

macOS에 템플릿을 전역 설치하지 않으려면 `build.py`에 공식 `web_nothreads_release.zip` 경로를 `--template`로 전달합니다.
로컬 진단은 출력 경로 옆 `quiet-private-diagnostics-*`에 있으며 Public 저장소에 올리지 않습니다.
Linux Actions에서는 엔진·템플릿을 runner 임시 경로에 설치합니다.

## 실험 중단과 키 회전

중단할 때는 원본의 실험용 Webhook과 웹 저장소의 배포 워크플로를 비활성화하거나 Pages를 해제하면 됩니다.
dispatch 토큰은 GitHub에서 폐기하고 Worker Secret을 제거합니다. HMAC 키는 Worker Secret과 원본 Webhook 설정을 함께 교체합니다.
원본 읽기 권한은 원본 Settings → Deploy keys의 `quiet-solitaire-web experimental CI (read-only)`를 삭제해 폐기합니다.
회전할 때는 새 읽기 전용 키를 원본에 등록하고 웹 저장소 Secret을 교체한 다음 기존 키를 삭제합니다.
이 작업은 원본의 앱 개발·빌드에 영향을 주지 않습니다.

공식 참고: [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
[GitHub Webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[Godot 4.7 Web export](https://docs.godotengine.org/en/4.7/tutorials/export/exporting_for_web.html).
