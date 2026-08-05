# AI-APP-CODE

로컬 LLM(Ollama)을 이용해 소스코드의 **보안 약점을 자동으로 분석**하고, 결과를 JSON 리포트와 Slack 알림으로 전달하는 도구 모음입니다.

외부 API로 코드를 전송하지 않고 로컬에서만 추론하므로, 사내 소스코드를 외부에 노출하지 않고 분석할 수 있습니다.

## 구성

| 디렉터리 | 설명 |
|---|---|
| `code-reviewer/` | 메인 분석 엔진. 소스 파일을 순회하며 Ollama에 취약점 분석을 요청하고 리포트를 생성합니다. |
| `ollama-mcp-server/` | Ollama를 MCP(Model Context Protocol)로 노출하는 서버. Claude Desktop 등 MCP 클라이언트에서 Ollama를 쓰기 위한 보조 도구입니다. (서드파티, MIT) |
| `docs/` | 실행 결과 예시 스크린샷 |

## 동작 방식

```
target_dir/ 소스코드
      │
      ├─ STEP 1    파일 탐색 및 확장자 필터링 (.js .css .html .jsp .sql .java .xml)
      ├─ STEP 1.5  설정 파일(pom.xml, application.yml 등) 기반 기술 스택 자동 판별
      ├─ STEP 2    파일별 취약점 분석 (main 경로의 .java / .jsp / .sql 대상)
      │              ├─ 사전 필터(Triage): 보안 관련 키워드 없는 파일은 LLM 호출 생략
      │              ├─ Ollama /api/chat 호출 (JSON 강제 출력, 최대 3회 재시도)
      │              └─ 응답 정제 · 스키마 검증 · 환각(영문 응답) 차단
      │
      ├─ audit_report.json   취약점 상세 리포트 (파일 1개 완료 시마다 실시간 저장)
      ├─ analysis_debug.log  전체 원시 응답 기록
      └─ Slack Webhook       심각도별 통계 + 유형별 취약 파일 목록 요약 전송
```

### 주요 특징

- **이어하기(Resume)**: 기존 리포트/디버그 로그가 있으면 이미 분석한 파일을 건너뛰고 이어서 진행합니다.
- **실시간 진행률**: 진행 바와 안전/취약/에러/스킵 통계를 터미널에 실시간 표시합니다.
- **대용량 파일 스킵**: `.java` 250KB, `.jsp` 150KB, 그 외 100KB 초과 파일은 자동 제외합니다.
- **한국어 응답 강제**: 응답의 한글 문자 수를 검사해 영문 환각 응답을 차단하고 재시도합니다.
- **Slack 메시지 길이 제어**: 4,000자 제한을 고려해 본문을 3,000자로 잘라내고 생략 건수를 안내합니다.

## 사전 준비

- [Node.js](https://nodejs.org) 20.6 이상 (`--env-file` 옵션 사용)
- [Ollama](https://ollama.ai) 설치 및 실행
- 분석 모델 다운로드

```bash
ollama pull qwen2.5-coder:7b
ollama serve
```

> 기본 설정은 RAM 16GB 환경 기준으로 튜닝되어 있습니다(단일 워커, `num_ctx: 3072`). 메모리가 더 넉넉하면 `reviewer.js`의 `CONCURRENCY_LIMIT`과 `num_ctx` 값을 올려 처리량을 높일 수 있습니다.

## 설치 및 실행

```bash
git clone https://github.com/kang30984/codereview.git

# 1) 환경변수 설정
cp .env.example .env
# .env 를 열어 SLACK_WEBHOOK_URL 등을 채워 넣습니다.

# 2) 분석할 소스코드를 target_dir 에 배치
cp -r /path/to/your-project/* code-reviewer/target_dir/

# 3) 실행
cd code-reviewer
node --env-file=../.env reviewer.js
```

`reviewer.js`는 Node.js 내장 모듈(`fs`, `path`, `readline`)과 `fetch`만 사용하므로 **별도의 `npm install` 없이 바로 실행됩니다.** (`package.json`의 의존성은 향후 LangChain 연동을 위해 남겨둔 것으로, 현재 코드에서는 사용하지 않습니다.)

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SLACK_WEBHOOK_URL` | (없음) | Slack Incoming Webhook URL. 비어 있으면 알림 전송을 건너뜁니다. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 서버 주소 |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | 분석에 사용할 모델 |
| `TARGET_DIR` | `./target_dir` | 분석 대상 디렉터리 |
| `ALLOW_INSECURE_TLS` | `0` | `1`이면 TLS 인증서 검증을 비활성화합니다. 사내 자체 서명 인증서 환경에서만 사용하세요. |

## 산출물

| 파일 | 설명 |
|---|---|
| `audit_report.json` | 분석 일시, 기술 스택, 취약점 상세(유형·심각도·라인·분석·수정 코드) |
| `analysis_status.log` | 실행 단계별 진행 로그 |
| `analysis_debug.log` | 파일별 LLM 원시 응답 (환각·파싱 실패 추적용) |

세 파일 모두 실행 시 생성되는 산출물이므로 `.gitignore`에 등록되어 있습니다.

### 리포트 예시 구조

```json
{
  "analyzedAt": "2026-05-26T08:23:32.460+09:00",
  "framework": {
    "language": "Java",
    "framework": "Spring",
    "dbTechnology": "Oracle, MySQL, MariaDB",
    "summary": "..."
  },
  "vulnerabilities": [
    {
      "fileName": "src/main/java/.../EgovComUtl1Controller.java",
      "vulnerable": true,
      "vulnerabilityTypes": {
        "XSS 취약점": [
          {
            "severity": "High",
            "location": "142",
            "analysis": "사용자 입력값을 검증 없이 응답에 출력합니다.",
            "fixedCode": "출력 시 HTML 이스케이프 처리를 적용합니다. ..."
          }
        ]
      }
    }
  ]
}
```

### Slack 알림 예시

![Slack 알림 예시](docs/slack-notification-example.png)

## ollama-mcp-server

`ollama-mcp-server/`는 서드파티 프로젝트 [hyzhak/ollama-mcp-server](https://github.com/hyzhak/ollama-mcp-server)(MIT, 원작 [NightTrek/Ollama-mcp](https://github.com/NightTrek/Ollama-mcp))의 사본이며, 빌드 산출물(`build/index.js`)만 포함되어 있습니다. TypeScript 원본 소스는 포함되어 있지 않으므로 이 디렉터리에서 `npm install`/`npm run build`는 동작하지 않습니다.

직접 설치해 사용하는 편이 좋습니다.

```json
{
  "mcpServers": {
    "ollama": {
      "command": "npx",
      "args": ["ollama-mcp-server"]
    }
  }
}
```

자세한 사용법은 [`ollama-mcp-server/README.md`](ollama-mcp-server/README.md)를 참고하세요.

## 보안 주의사항

- **`.env` 파일은 절대 커밋하지 마세요.** Webhook URL, API 키 등은 모두 환경변수로만 주입합니다.
- 분석 대상 소스코드(`target_dir/`)는 `.gitignore`에 등록되어 있습니다. 사내 코드가 실수로 공개 저장소에 올라가지 않도록 유지하세요.
- `audit_report.json`에는 취약점 위치와 코드 조각이 포함됩니다. 외부에 공유하지 마세요.
- `ALLOW_INSECURE_TLS=1`은 TLS 검증을 끄므로 중간자 공격에 노출됩니다. 신뢰된 내부망에서만 사용하세요.

## 라이선스

- `code-reviewer/` — ISC
- `ollama-mcp-server/` — MIT (원저작권자 표기는 해당 디렉터리의 `LICENSE` 참고)
