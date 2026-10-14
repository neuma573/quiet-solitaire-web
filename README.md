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
- 깨끗한 checkout의 CSV 번역을 생성하기 위해 임시 복사본에서 번역 참조를 잠시 비우고 import한 뒤 원래 `project.godot` 바이트를 복원합니다. 이후 공식 전체 테스트를 실행하고 원본 checkout은 바꾸지 않습니다.
- 임시 복사본의 iOS export preset을 Web preset으로 대체하고, `gui/theme/custom_font`로 Noto Sans CJK를 폴백 폰트에 지정합니다. 게임 코드·번역·씬은 수정하지 않습니다.
- 브라우저는 원본의 시스템 폰트를 제공하지 않아 CJK 폰트가 필요합니다. 폰트는 고정된 공식 notofonts 커밋에서 다운로드하고 SHA256을 검증합니다. SIL OFL 1.1 전문은 배포물의 `FONT-LICENSE.txt`에 포함하며 원본에는 폰트를 추가하지 않습니다.
- PWA·오프라인 캐시는 추가하지 않습니다. 원본과 동일하게 진행 중인 게임 재개 저장은 없으며 설정·통계 보존은 브라우저 IndexedDB 정책의 영향을 받습니다.
- Chromium에서 실제 실행을 확인합니다. iPhone Safari의 성능·터치·안전 영역, VoiceOver는 별도 실기기 검증 대상입니다.

## 로컬 검증

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
