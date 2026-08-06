import fs from 'fs';
import path from 'path';
import readline from 'readline';

// [WARNING] 사내 프록시/자체 인증서 환경 때문에 TLS 검증을 끄는 설정입니다.
// 외부 네트워크 환경에서는 반드시 제거하거나 ALLOW_INSECURE_TLS=1 로만 사용하세요.
if (process.env.ALLOW_INSECURE_TLS === '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// [Config] 모든 설정은 환경변수로 주입합니다. (.env.example 참고)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_URL = `${OLLAMA_BASE_URL}/api/generate`;
const OLLAMA_CHAT_URL = `${OLLAMA_BASE_URL}/api/chat`;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
const TARGET_DIR = process.env.TARGET_DIR || './target_dir';
const REPORT_FILE = 'audit_report.json';
const LOG_FILE = 'analysis_status.log';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
// main 디렉터리 경로 필터 모드. (기본값: auto)
//   auto : TARGET_DIR 을 스캔해 표준 구조(main 존재)/레거시 구조를 자동으로 판별합니다.
//   1    : 항상 경로에 'main' 이 있는 파일만 분석 (Maven/Gradle 표준 구조 강제)
//   0    : 항상 전체 소스를 분석 (레거시 구조 강제)
const REQUIRE_MAIN_PATH_MODE = (() => {
    const raw = (process.env.REQUIRE_MAIN_PATH ?? 'auto').trim().toLowerCase();
    if (raw === '1' || raw === 'true') return 'force-on';
    if (raw === '0' || raw === 'false') return 'force-off';
    return 'auto';
})();
// 레거시 구조에서 테스트 코드를 분석 대상에서 제외할지 여부. (기본: 제외)
// 표준 구조는 src/main 필터만으로 src/test 가 자연히 빠지지만, 레거시 구조는 그렇지 않습니다.
const EXCLUDE_TEST_PATHS = process.env.EXCLUDE_TEST_PATHS !== '0';
// 리포트를 TARGET_DIR 안에도 복사할지 여부. 기본은 비활성(취약점 상세 유출 방지).
const COPY_REPORT_TO_TARGET = process.env.COPY_REPORT_TO_TARGET === '1';

// [Logger Utility]
const logger = {
    clearLine: () => {
        if (process.stdout.isTTY) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
        }
    },
    info: (msg) => {
        logger.clearLine();
        const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const output = `[${timestamp}] [INFO] ${msg}`;
        console.log(output);
        fs.appendFileSync(LOG_FILE, output + '\n');
    },
    step: (msg) => {
        logger.clearLine();
        const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const output = `\n[${timestamp}] 🚀 ${msg}`;
        console.log(output);
        fs.appendFileSync(LOG_FILE, output + '\n');
    },
    warn: (msg) => {
        logger.clearLine();
        const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const output = `[${timestamp}] [WARN] ⚠️ ${msg}`;
        console.warn(output);
        fs.appendFileSync(LOG_FILE, output + '\n');
    },
    error: (msg) => {
        logger.clearLine();
        const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const output = `[${timestamp}] [ERROR] ❌ ${msg}`;
        console.error(output);
        fs.appendFileSync(LOG_FILE, output + '\n');
    },
    liveStatus: (msg) => {
        if (process.stdout.isTTY) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(msg);
        } else {
            console.log(msg);
        }
    },
    drawProgressBar: (current, total, length = 30) => {
        if (!total || total <= 0) return `|${'░'.repeat(length)}| 0% (0/0)`;
        const filledLength = Math.round((current / total) * length);
        const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength);
        const percent = Math.round((current / total) * 100);
        return `|${bar}| ${percent}% (${current}/${total})`;
    }
};

// 기존 로그를 지우지 않고 세션 구분선을 추가합니다. (이어하기 시 이전 실행 기록 보존)
if (fs.existsSync(LOG_FILE)) {
    fs.appendFileSync(LOG_FILE, `\n${'='.repeat(60)}\n=== 새 세션 시작 ===\n${'='.repeat(60)}\n`);
}
logger.step('보안 분석 스크립트 엔진 가동 시작');

const ALLOWED_EXTENSIONS = ['.js', '.css', '.html', '.jsp', '.sql', '.java', '.xml'];
// 실제 보안 분석 대상 확장자
const SOURCE_EXTENSIONS = ['.java', '.jsp', '.sql'];
// 탐색 시 건너뛸 디렉터리 (빌드 산출물/의존성은 분석 의미가 없고 오탐만 늘립니다)
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'target', 'build', 'bin', 'out', '.idea', '.settings']);
// 레거시 구조에서 테스트 코드로 간주할 디렉터리명
const TEST_DIR_NAMES = new Set(['test', 'tests', 'testcase', 'testcases', '__tests__']);

/** TARGET_DIR 기준 상대 경로의 디렉터리 세그먼트 배열을 반환합니다. */
function relSegments(file) {
    return path.relative(TARGET_DIR, file).split(path.sep);
}

/** 경로에 'main' 디렉터리가 포함되어 있는지 (Maven/Gradle 표준 구조 여부) */
function isUnderMainDir(file) {
    return relSegments(file).includes('main');
}

/** 경로가 테스트 코드로 보이는지 */
function isTestPath(file) {
    return relSegments(file).some(seg => TEST_DIR_NAMES.has(seg.toLowerCase()));
}

/**
 * 프로젝트 구조를 판별합니다.
 * main 디렉터리가 "있는 경우"와 "없는 경우"를 구분해 필터 정책을 결정합니다.
 */
function detectProjectLayout(allFiles) {
    const candidates = allFiles.filter(f => SOURCE_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    const mainFiles = candidates.filter(isUnderMainDir);
    const outsideMain = candidates.length - mainFiles.length;

    let requireMain;
    let layout;
    if (REQUIRE_MAIN_PATH_MODE === 'force-on') {
        requireMain = true;
        layout = 'standard(강제)';
    } else if (REQUIRE_MAIN_PATH_MODE === 'force-off') {
        requireMain = false;
        layout = 'legacy(강제)';
    } else {
        // auto: main 아래에 소스가 하나라도 있으면 표준 구조로 간주
        requireMain = mainFiles.length > 0;
        layout = requireMain ? 'standard(자동판별)' : 'legacy(자동판별)';
    }
    return { requireMain, layout, candidates, mainFiles, outsideMain };
}

// [Preflight] Ollama 서버 연결 및 모델 존재 여부를 먼저 확인합니다.
// 이 검사가 없으면 서버가 꺼져 있어도 전 파일이 조용히 error 처리되고
// "취약점 0건" 리포트가 생성되어 안전한 것으로 오인될 수 있습니다.
async function preflightCheck() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let tags;
    try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        tags = await res.json();
    } catch (e) {
        const reason = e.name === 'AbortError' ? '응답 시간 초과(10초)' : e.message;
        logger.error(`Ollama 서버에 연결할 수 없습니다: ${OLLAMA_BASE_URL} (${reason})`);
        logger.error("해결 방법: 별도 터미널에서 'ollama serve' 를 실행한 뒤 다시 시도하세요.");
        logger.error('원격 서버를 쓰는 경우 OLLAMA_BASE_URL 환경변수를 확인하세요.');
        return false;
    } finally {
        clearTimeout(timer);
    }

    const available = (tags.models || []).map(m => m.name);
    logger.info(`Ollama 연결 확인 완료 (설치된 모델 ${available.length}개)`);

    // 태그 생략 입력(qwen2.5-coder)도 latest 로 간주해 비교합니다.
    const wanted = OLLAMA_MODEL.includes(':') ? OLLAMA_MODEL : `${OLLAMA_MODEL}:latest`;
    if (available.length > 0 && !available.some(n => n === wanted || n === OLLAMA_MODEL)) {
        logger.error(`모델 '${OLLAMA_MODEL}' 을 찾을 수 없습니다. 설치된 모델: ${available.join(', ') || '없음'}`);
        logger.error(`해결 방법: 'ollama pull ${OLLAMA_MODEL}' 를 실행하세요.`);
        return false;
    }
    return true;
}

function findConfigFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (!IGNORED_DIRS.has(file)) {
                findConfigFiles(filePath, fileList);
            }
        } else {
            const targetPatterns = ['package.json', 'pom.xml', 'build.gradle', 'application.properties', 'application.yml', 'database.properties', 'globals.properties', 'context-datasource.xml'];
            if (targetPatterns.includes(file)) {
                fileList.push(filePath);
            }
        }
    });
    return fileList;
}

function getAllFiles(dirPath, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);
    files.forEach((file) => {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (IGNORED_DIRS.has(file)) return;
            getAllFiles(fullPath, arrayOfFiles);
        } else {
            const ext = path.extname(fullPath).toLowerCase();
            if (ALLOWED_EXTENSIONS.includes(ext)) {
                arrayOfFiles.push(fullPath);
            }
        }
    });
    return arrayOfFiles;
}

async function analyzeFramework(allFiles) {
    logger.step('STEP 1.5: 대상 소스코드 기반 프레임워크 및 기술 스택 분석 중...');
    const foundFiles = findConfigFiles(TARGET_DIR);
    let configContents = '';

    for (const fullPath of foundFiles) {
        const fileName = path.basename(fullPath);
        let content = fs.readFileSync(fullPath, 'utf8');
        if (fileName.match(/\.(properties|yml|xml)$/)) {
            const lines = content.split('\n');
            const hasGeniushub = lines.some(line => line.includes('geniushub'));
            content = lines.filter(line => {
                const lowerLine = line.toLowerCase();
                const isDbKeyword = /jdbc|url|driver|username|oracle|altibase|mysql|mariadb|postgres|sqlserver|tibero|cubrid|dual|dialect/i.test(line);
                if (hasGeniushub) {
                    if (lowerLine.includes('geniushub')) return true;
                    if (lowerLine.includes('globals.dbtype')) return false;
                    if (/globals\.(mysql|oracle|altibase|tibero|cubrid|maria|postgres)\./i.test(line)) return false;
                }
                return isDbKeyword;
            }).join('\n');
        }
        if (content.trim()) {
            configContents += `\n[File: ${path.relative(TARGET_DIR, fullPath)}]\n${content.substring(0, 3000)}\n`;
        }
    }

    let promptInstruction = '';
    if (configContents.trim()) {
        promptInstruction = `[SYSTEM ROLE]\n기술 스택 분석 전문가입니다.\n[TASK]\n프레임워크 및 DB 기술을 식별하십시오. JSON 형식으로만 답변하십시오.\n{ "language": "언어", "framework": "프레임워크", "dbTechnology": "DB기술", "summary": "요약" }\n[CONFIGURATION FILES]\n${configContents}`.trim();
    } else {
        logger.info('설정 파일이 없어 소스코드 파일명과 내용을 바탕으로 프레임워크를 유추합니다.');
        const sampleFiles = allFiles.slice(0, 50).map(f => path.relative(TARGET_DIR, f)).join('\n');
        let sampleContents = '';
        for (let i = 0; i < Math.min(3, allFiles.length); i++) {
            const content = fs.readFileSync(allFiles[i], 'utf8').substring(0, 1500);
            sampleContents += `\n[File: ${path.relative(TARGET_DIR, allFiles[i])}]\n${content}\n`;
        }
        promptInstruction = `[SYSTEM ROLE]
You are a Technical Stack Analyst. 
1. Respond ONLY in valid JSON.
2. Language: Korean.
3. NEVER use Chinese characters (Hanzi/中文).

[TASK]
Identify framework and DB technologies.
{ "language": "string", "framework": "string", "dbTechnology": "string", "summary": "string" }

[FILE PATHS]
${sampleFiles}
[SAMPLE CODE]
${sampleContents}
`.trim();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const liveInterval = setInterval(() => {
        logger.liveStatus(`  ${spinner[i % spinner.length]} AI 프레임워크 분석 중... (${(i * 0.1).toFixed(1)}s)`);
        i++;
    }, 100);

    try {
        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                format: 'json',
                prompt: promptInstruction,
                stream: false,
                options: { temperature: 0.1, num_ctx: 4096, num_predict: 1000 }
            }),
            signal: controller.signal
        });
        if (response.ok) {
            const data = await response.json();
            let resultText = data.response.trim();
            const startIdx = resultText.indexOf('{');
            const endIdx = resultText.lastIndexOf('}');
            if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) resultText = resultText.substring(startIdx, endIdx + 1);

            // 정제 로직 추가
            const sanitizedText = resultText
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
                .replace(/"((?:[^"\\]|\\.)*)"/gs, (m, p1) => '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"');

            try {
                const parsedResult = JSON.parse(sanitizedText);
                logger.info(`프레임워크 분석 완료: ${parsedResult.language} / ${parsedResult.framework}`);
                return parsedResult;
            } catch (e) {
                logger.warn('프레임워크 JSON 파싱 실패');
                return resultText;
            }
        }
    } catch (e) {
        logger.warn(`프레임워크 분석 중 오류 발생: ${e.message}`);
    } finally {
        // [FIX] 성공 경로에만 있으면 fetch 실패 시 인터벌이 누수되어
        // 이벤트 루프가 비워지지 않고 프로세스가 종료되지 않습니다.
        clearInterval(liveInterval);
        clearTimeout(timeout);
        logger.clearLine();
    }
    return '기본 웹 환경';
}

// [Slack Incoming Webhook 전송]
async function sendToSlack(report) {
    if (!SLACK_WEBHOOK_URL) return;

    const framework = report.framework || {};
    const vulnerabilities = report.vulnerabilities || [];

    let highCount = 0, mediumCount = 0, lowCount = 0;
    vulnerabilities.forEach(v => {
        if (v.vulnerabilityTypes) {
            Object.values(v.vulnerabilityTypes).forEach(list => {
                list.forEach(detail => {
                    const severity = (detail.severity || '').toLowerCase();
                    if (severity === 'high') highCount++;
                    else if (severity === 'medium') mediumCount++;
                    else if (severity === 'low') lowCount++;
                });
            });
        }
    });
    const totalCount = highCount + mediumCount + lowCount;

    // 1. 경로 축약 헬퍼 함수 (뒤쪽 주요 경로 2단계만 남김)
    const shortenPath = (filePath) => {
        const cleanPath = filePath.replace(/\\/g, '/');
        const parts = cleanPath.split('/');
        if (parts.length > 2) {
            return '.../' + parts.slice(-2).join('/');
        }
        return cleanPath;
    };

    // 2. 취약점 유형별 그룹화
    const groups = {}; // { "취약점 유형": { severity: "High/Medium/Low", files: Set } }

    vulnerabilities.forEach(v => {
        if (!v.vulnerabilityTypes) return;
        const fileName = v.fileName || '';
        const shortName = shortenPath(fileName);

        Object.entries(v.vulnerabilityTypes).forEach(([type, details]) => {
            let itemSeverity = 'Low';
            details.forEach(d => {
                const sev = d.severity || 'Low';
                const sLower = sev.toLowerCase();
                if (sLower === 'high') itemSeverity = 'High';
                else if (sLower === 'medium' && itemSeverity !== 'High') itemSeverity = 'Medium';
            });

            if (!groups[type]) {
                groups[type] = {
                    severity: itemSeverity,
                    files: new Set()
                };
            } else {
                // 기존 그룹의 심각도와 비교하여 더 높은 것을 대표값으로 사용
                const currentSev = groups[type].severity.toLowerCase();
                const newSev = itemSeverity.toLowerCase();
                if (newSev === 'high' || (newSev === 'medium' && currentSev === 'low')) {
                    groups[type].severity = itemSeverity;
                }
            }
            groups[type].files.add(shortName);
        });
    });

    // 3. Slack 메시지 포맷팅 및 글자 수 제한 제어
    const detailLines = [];
    let characterCount = 0;
    let limitExceeded = false;
    let skippedCount = 0;

    const getSeverityEmoji = (sev) => {
        const s = (sev || '').toLowerCase();
        if (s === 'high') return '🔴';
        if (s === 'medium') return '🟡';
        return '🟢';
    };

    // 심각도 가중치 기준 정렬 (High -> Medium -> Low 순)
    const sortedGroups = Object.entries(groups).sort((a, b) => {
        const severityOrder = { high: 3, medium: 2, low: 1 };
        const sevA = severityOrder[a[1].severity.toLowerCase()] || 0;
        const sevB = severityOrder[b[1].severity.toLowerCase()] || 0;
        return sevB - sevA;
    });

    for (const [type, group] of sortedGroups) {
        const emoji = getSeverityEmoji(group.severity);
        const fileListStr = Array.from(group.files).map(f => `\`${f}\``).join(', ');
        const line = `• ${emoji} *${type}* (${group.severity}):\n  ${fileListStr}`;

        if (limitExceeded) {
            skippedCount += group.files.size;
            continue;
        }

        // Slack 메시지 글자 제한(4000자) 대비 상세 본문 영역을 3000자로 제안
        if (characterCount + line.length > 3000) {
            limitExceeded = true;
            skippedCount += group.files.size;
            continue;
        }

        detailLines.push(line);
        characterCount += line.length + 1;
    }

    if (limitExceeded) {
        detailLines.push(`• _⚠️ Slack 메시지 길이 제한으로 인해 그 외 ${skippedCount}개 파일 생략 (전체 내역은 ${REPORT_FILE} 파일 확인)_`);
    }

    const detailSection = detailLines.length > 0
        ? `\n📋 *유형별 취약 파일 리스트*:\n${detailLines.join('\n')}`
        : '';

    const payload = {
        text: `🛡️ *보안 약점 자동 분석 결과 리포트* 🛡️\n\n` +
              `• *분석 일시*: ${report.analyzedAt}\n` +
              `• *프레임워크*: ${framework.language || 'N/A'} / ${framework.framework || 'N/A'}\n` +
              `• *DB 기술*: \`${framework.dbTechnology || 'N/A'}\`\n\n` +
              `🚨 *발견된 취약점 통계*: 총 *${totalCount}* 건\n` +
              `  • 🔴 *High (심각)*: ${highCount}건\n` +
              `  • 🟡 *Medium (경고)*: ${mediumCount}건\n` +
              `  • 🟢 *Low (주의)*: ${lowCount}건` +
              detailSection
    };

    try {
        const response = await fetch(SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            logger.info('✅ Slack Incoming Webhook 알림 전송 성공!');
        } else {
            logger.warn(`Slack 알림 전송 실패: HTTP ${response.status}`);
        }
    } catch (err) {
        logger.warn(`Slack 알림 전송 오류: ${err.message}`);
    }
}

// [Report Writer] 리포트 저장. TARGET_DIR 복사는 COPY_REPORT_TO_TARGET=1 일 때만 수행합니다.
// (리포트에는 취약점 위치와 코드 조각이 포함되므로 기본적으로 분석 대상 폴더에 남기지 않습니다.)
function writeReport(report) {
    const reportData = JSON.stringify(report, null, 2);
    fs.writeFileSync(REPORT_FILE, reportData, 'utf8');
    if (!COPY_REPORT_TO_TARGET) return;
    try {
        fs.writeFileSync(path.join(TARGET_DIR, REPORT_FILE), reportData, 'utf8');
    } catch (err) {
        logger.warn(`공유 디렉토리 복사 실패: ${err.message}`);
    }
}

async function runReview() {
    try {
        // [FIX] Ollama 가 준비되지 않은 상태로 진행하면 전 파일이 조용히 실패하고
        // "취약점 0건" 리포트가 남습니다. 대화형 프롬프트 이전에 먼저 검사합니다.
        logger.step('STEP 0: Ollama 서버 연결 확인');
        if (!await preflightCheck()) {
            process.exitCode = 1;
            return;
        }

        let existingVulnerabilities = [];
        let processedFiles = new Set();
        const DEBUG_LOG_FILE = path.join(process.cwd(), 'analysis_debug.log');

        if (fs.existsSync(REPORT_FILE) || fs.existsSync(DEBUG_LOG_FILE)) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise(resolve => {
                rl.question(`\n기존 분석 기록이 존재합니다. 이어서 분석하시겠습니까? (y/n, 기본값: y): `, resolve);
            });
            rl.close();

            if (answer.toLowerCase() === 'n') {
                if (fs.existsSync(REPORT_FILE)) fs.unlinkSync(REPORT_FILE);
                const containerReport = path.join(TARGET_DIR, REPORT_FILE);
                if (fs.existsSync(containerReport)) fs.unlinkSync(containerReport);
                if (fs.existsSync(DEBUG_LOG_FILE)) fs.unlinkSync(DEBUG_LOG_FILE);
                logger.info('기존 기록을 모두 삭제하고 새로 시작합니다.');
            } else {
                if (fs.existsSync(REPORT_FILE)) {
                    try {
                        const existingData = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
                        if (existingData.vulnerabilities) existingVulnerabilities = existingData.vulnerabilities;
                    } catch (e) {
                        logger.warn('리포트 파일 파싱 실패');
                    }
                }
                if (fs.existsSync(DEBUG_LOG_FILE)) {
                    const logContent = fs.readFileSync(DEBUG_LOG_FILE, 'utf8');
                    // 정규식으로 RESULT 내의 fileName 추출 (이미 분석 완료된 파일)
                    const matches = [...logContent.matchAll(/"fileName"\s*:\s*"([^"]+)"/g)];
                    matches.forEach(m => processedFiles.add(m[1].replace(/\\\\/g, '\\')));
                }
                logger.info(`이어하기 모드: 기존 취약점 ${existingVulnerabilities.length}개 유지, 완료된 파일 ${processedFiles.size}개 건너뜀.`);
            }
        }
        
        if (!fs.existsSync(TARGET_DIR)) {
            logger.error(`에러: '${TARGET_DIR}' 폴더가 없습니다.`);
            return;
        }
        logger.step('STEP 1: 모든 파일 탐색 및 필터링 시작');
        const allFiles = getAllFiles(TARGET_DIR);
        logger.info(`발견된 전체 파일: ${allFiles.length}개`);
        if (allFiles.length === 0) {
            logger.warn('분석할 파일이 없습니다. 종료합니다.');
            return;
        }

        const frameworkContext = await analyzeFramework(allFiles);
        const kstTime = new Date(new Date().getTime() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
        const finalReport = { analyzedAt: kstTime, framework: frameworkContext, vulnerabilities: existingVulnerabilities };
        // 대상 파일 필터링 (보안 분석에 의미 없는 확장자 제외)
        // main 디렉터리 유무에 따라 필터 정책을 분기합니다.
        const layoutInfo = detectProjectLayout(allFiles);
        const { requireMain, candidates } = layoutInfo;
        logger.info(`프로젝트 구조 판별: ${layoutInfo.layout} / 소스 후보 ${candidates.length}개 (main 하위 ${layoutInfo.mainFiles.length}개, main 밖 ${layoutInfo.outsideMain}개)`);

        let targetSrcFiles;
        if (requireMain) {
            // [CASE A] main 디렉터리가 있는 표준 구조: src/main/** 만 분석 (테스트 코드는 자연히 제외)
            targetSrcFiles = layoutInfo.mainFiles;
            logger.info(`표준 구조(Maven/Gradle)로 판단하여 경로에 'main' 이 포함된 파일만 분석합니다.`);
            if (layoutInfo.outsideMain > 0) {
                logger.warn(`main 밖의 소스 ${layoutInfo.outsideMain}개는 제외되었습니다. 전체를 분석하려면 REQUIRE_MAIN_PATH=0 으로 실행하세요.`);
            }
        } else {
            // [CASE B] main 디렉터리가 없는 레거시 구조: 전체 소스를 분석
            targetSrcFiles = candidates;
            logger.info(`레거시 구조(src/com/..., WebContent/ 등)로 판단하여 전체 소스를 분석합니다.`);
            if (EXCLUDE_TEST_PATHS) {
                const before = targetSrcFiles.length;
                targetSrcFiles = targetSrcFiles.filter(f => !isTestPath(f));
                const removed = before - targetSrcFiles.length;
                if (removed > 0) {
                    logger.info(`테스트 코드로 보이는 파일 ${removed}개를 제외했습니다. (포함하려면 EXCLUDE_TEST_PATHS=0)`);
                }
            }
        }

        // [FIX] 0개일 때 조용히 "정상 완료"로 끝나면 취약점이 없는 것으로 오인됩니다.
        if (targetSrcFiles.length === 0) {
            logger.error('분석 대상 파일이 0개입니다. 리포트를 생성하지 않고 종료합니다.');
            if (candidates.length === 0) {
                logger.error(`TARGET_DIR('${TARGET_DIR}') 안에 .java/.jsp/.sql 파일이 있는지 확인하세요.`);
            } else if (requireMain) {
                logger.error(`.java/.jsp/.sql 파일 ${candidates.length}개가 있지만 경로에 'main' 디렉터리가 없어 모두 제외되었습니다.`);
                logger.error('REQUIRE_MAIN_PATH 를 지우거나(auto) 0 으로 설정하고 다시 실행하세요.');
            } else {
                logger.error(`.java/.jsp/.sql 파일 ${candidates.length}개가 모두 테스트 경로로 판단되어 제외되었습니다. EXCLUDE_TEST_PATHS=0 으로 실행해 보세요.`);
            }
            process.exitCode = 1;
            return;
        }

        if (processedFiles.size > 0) {
            const beforeCount = targetSrcFiles.length;
            targetSrcFiles = targetSrcFiles.filter(file => {
                const relPath = path.relative(TARGET_DIR, file);
                return !processedFiles.has(relPath) && !processedFiles.has(relPath.replace(/\\/g, '/'));
            });
            logger.info(`이미 분석된 파일 ${beforeCount - targetSrcFiles.length}개를 제외하고 ${targetSrcFiles.length}개만 분석합니다.`);
        }
        
        logger.info(`보안 분석 대상(핵심 소스코드 필터링): ${targetSrcFiles.length}개`);
        logger.step('STEP 2: 핵심 파일별 취약점 분석 시작');

        let currentIndex = 0;
        const totalFiles = targetSrcFiles.length;
        const CONCURRENCY_LIMIT = 1; // 16GB 램 환경에서 Swap 방지 및 최고 속도를 위한 단일 워커
        const vulnerabilities = existingVulnerabilities;
        const activeFiles = new Map();
        
        // 분석 통계 추적용 변수 (이어하기 시 카운트는 진행된 것 기준)
        // [FIX] processedFiles 에는 취약 파일도 포함되므로 그대로 safe 에 넣으면
        // vulnerable 과 중복 집계되어 합계가 실제 처리 파일 수를 초과합니다.
        const statsCount = {
            safe: Math.max(0, processedFiles.size - existingVulnerabilities.length),
            vulnerable: existingVulnerabilities.length,
            error: 0,
            skipped: 0,
            triaged: 0   // 사전 필터로 LLM 호출을 생략한 파일 (검사된 것이 아님)
        };
        // 이번 세션에서 모델이 실제로 판정을 내린 파일 수. 0이면 분석이 성립하지 않은 것입니다.
        let modelJudgedThisRun = 0;

        const updateDisplay = () => {
            if (!process.stdout.isTTY) return;
            const progressBar = logger.drawProgressBar(currentIndex, totalFiles);
            const now = Date.now();
            const activeList = Array.from(activeFiles.entries())
                .map(([name, startTime]) => {
                    const elapsed = ((now - startTime) / 1000).toFixed(1);
                    return `${name}(${elapsed}s)`;
                })
                .join(', ');

            readline.cursorTo(process.stdout, 0, 0);
            readline.clearScreenDown(process.stdout);
            process.stdout.write(`\x1B[1;36m보안 분석 진행 중 (단일 워커 / 7B)\x1B[0m\n`);
            process.stdout.write(`${progressBar}\n`);
            process.stdout.write(`\x1B[1;32m[통계]\x1B[0m 안전: ${statsCount.safe} | \x1B[1;31m취약: ${statsCount.vulnerable}\x1B[0m | 에러/환각: ${statsCount.error} | 스킵: ${statsCount.skipped} | 사전필터: ${statsCount.triaged}\n\n`);
            process.stdout.write(`\x1B[1;33m[진행 중인 작업]\x1B[0m\n${activeList}\n`);
        };

        const displayInterval = setInterval(updateDisplay, 500);

        // 개별 파일 분석 (배치 해제)
        const processFile = async (filePath) => {
            const fileName = path.relative(TARGET_DIR, filePath);
            activeFiles.set(fileName, Date.now());
            updateDisplay();

            const MAX_RETRIES = 3;
            let retries = 0;
            let finalResult = null;

            while (retries < MAX_RETRIES) {
                try {
                    const stats = fs.statSync(filePath);
                    const ext = path.extname(filePath).toLowerCase();
                    const sizeLimit = ext === '.java' ? 250000 : ext === '.jsp' ? 150000 : 100000;
                    if (stats.size > sizeLimit) {
                        finalResult = { fileName, skipped: true }; // 확장자별 파일 크기 제한 스킵 (java:250KB, jsp:150KB, 기타:100KB)
                        break;
                    }

                    let rawContent = fs.readFileSync(filePath, 'utf8');
                    
                    // --- 사전 필터링 (Triage) ---
                    // 취약점 관련 키워드가 전혀 없으면 LLM 호출 생략 (단순 VO, DTO 등 필터링)
                    const securityKeywords = /sql|query|select|insert|update|delete|request|response|session|cookie|password|pwd|auth|login|crypto|encrypt|decrypt|cipher|file|stream|exec|system|process|Runtime|invoke|eval|script|onclick|onload|onerror|href|action|form|iframe|document\.|window\.|location|src\s*=/i;
                    if (!securityKeywords.test(rawContent)) {
                        finalResult = { fileName, vulnerable: false, skipped_by_triage: true };
                        break;
                    }
                    
                    let content = rawContent.substring(0, 10000); // 처리 속도 및 메모리 절약을 위해 10000자로 제한
                    // AI가 위치를 정확히 알 수 있도록 코드의 매 줄마다 라인 번호(1:, 2:)를 붙임
                    content = content.split('\n').map((line, idx) => `${idx + 1}: ${line}`).join('\n');
                    // 모델이 백슬래시(\)를 올바르게 처리하지 못해 JSON 파싱 에러가 나는 것을 방지하기 위해 이스케이프 처리
                    const safeFileName = fileName.replace(/\\/g, '\\\\');
                    const systemInstruction = `당신은 보안 취약점 분석 전문가입니다. 모든 분석 내용(analysis)과 수정 방법(fixedCode)은 반드시 **한국어(Korean)**로 작성해야 합니다. 절대 영어로 답변하지 마십시오. 코드 기능 요약, 해설, "response" 키 사용은 절대 금지됩니다. 오직 지정된 JSON 규격({"vulnerable": ...})만 출력하십시오.`;
                    const userInstruction = `[Rule]
1. 취약점이 없을 경우: 부가 설명이나 코드 요약 없이 오직 {"vulnerable": false} 만 출력하십시오. (절대 코드의 기능을 설명하거나 다른 키를 생성하지 마십시오)
2. 취약점이 있을 경우: 반드시 아래 [Output Format]의 영문 키(key)들을 그대로 사용하고, 값(value)만 한국어로 상세히 설명할 것.
3. 응답은 어떠한 마크다운 포맷팅(\`\`\`json 등)이나 부가 설명 없이, 오직 파싱 가능한 순수 JSON 문자열로만 반환하십시오.

[Output Format]
{
  "vulnerable": true,
  "vulnerabilityTypes": {
    "취약점명": [
      {
        "severity": "High/Medium/Low",
        "location": "라인 번호",
        "analysis": "한국어로 작성된 상세 분석",
        "fixedCode": "한국어로 작성된 수정 코드 및 설명"
      }
    ]
  }
}

[Code] File: ${safeFileName}
\`\`\`
${content}
\`\`\`

명심하십시오: 취약점이 없으면 오직 {"vulnerable": false}만 출력해야 합니다. 코드 요약, 메소드 설명, 예제 데이터 생성 등은 절대 금지됩니다.`;

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 300000); // 5분(300초) 타임아웃: 7B 모델의 연산 시간을 충분히 보장하되 무한정 대기 방지

                    // [FIX] fetch 가 reject 되면 clearTimeout 이 실행되지 않아
                    // 최대 5분짜리 타이머가 누수됩니다. finally 로 항상 정리합니다.
                    let response;
                    try {
                        response = await fetch(OLLAMA_CHAT_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: OLLAMA_MODEL,
                                format: 'json',
                                messages: [
                                    { role: 'system', content: systemInstruction },
                                    { role: 'user', content: userInstruction }
                                ],
                                stream: false,
                                options: { temperature: 0.1, num_predict: 400, num_ctx: 3072 } // 입력/출력 토큰 극단적 최적화
                            }),
                            signal: controller.signal
                        });
                    } finally {
                        clearTimeout(timeout);
                    }

                    if (response.ok) {
                        const data = await response.json();
                        let resultText = data.message.content.trim();
                        const startIdx = resultText.indexOf('{');
                        const endIdx = resultText.lastIndexOf('}');
                        if (startIdx !== -1) resultText = (endIdx === -1) ? (resultText.substring(startIdx) + ' ] } } ] }') : resultText.substring(startIdx, endIdx + 1);

                        let sanitizedText = resultText.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/,\s*([}\]])/g, "$1").replace(/"((?:[^"\\]|\\.)*)"/gs, (m, p1) => '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"');
                        
                        let parsedData = null;
                        let parseError = false;
                        try {
                            parsedData = JSON.parse(sanitizedText);
                        } catch (e) {
                            try {
                                parsedData = JSON.parse(sanitizedText.replace(/:\s*"([^"]*)"/g, (m, p1) => ': "' + p1.replace(/"/g, "'") + '"'));
                            } catch (e2) {
                                parseError = true;
                            }
                        }

                        if (parseError) {
                            throw new Error("Parse Failed");
                        }

                        if (parsedData.vulnerable === undefined) {
                            const keys = Object.keys(parsedData);
                            // 케이스 1: 단일 래퍼 키 안에 올바른 스키마가 있는 경우 ({"result": {"vulnerable": ...}})
                            if (keys.length === 1 && typeof parsedData[keys[0]] === 'object' && parsedData[keys[0]] !== null) {
                                if (parsedData[keys[0]].vulnerable !== undefined) {
                                    parsedData = parsedData[keys[0]];
                                }
                            }
                            // 케이스 2: 모델이 취약점 분석 대신 코드 요약/해설/데이터 예시를 반환한 경우
                            // (code, message, description, id, key, data 등 보안 분석과 무관한 키가 주류일 때)
                            const summaryWrapperKeys = [
                                'response', 'result', 'answer', 'summary', '응답', '결과', 
                                'code', 'message', 'description', 'explanation', 'id', 'key', 'data', '설명'
                            ];
                            if (parsedData.vulnerable === undefined && keys.some(k => summaryWrapperKeys.includes(k.toLowerCase()))) {
                                parsedData = { vulnerable: false, _note: 'model_returned_summary_treated_as_safe' };
                            }
                        }

                        if (parsedData.vulnerable === "false" || parsedData.vulnerable === "False" || parsedData.vulnerable === "FALSE") parsedData.vulnerable = false;
                        if (parsedData.vulnerable === "true" || parsedData.vulnerable === "True" || parsedData.vulnerable === "TRUE") parsedData.vulnerable = true;

                        if (typeof parsedData.vulnerable !== 'boolean') {
                            throw new Error(`Schema Validation Failed: 'vulnerable' is missing or not a boolean. Received: ${JSON.stringify(parsedData)}`);
                        }

                        if (!parsedData.fileName) parsedData.fileName = fileName; // 누락된 파일명 수동 주입
                        if (parsedData.vulnerable === false) {
                            delete parsedData.vulnerabilityTypes; // 빈 객체 제거
                        } else if (parsedData.vulnerable === true) {
                            // 취약점이 있다고 했지만 한글이 2글자 미만이라면 (영어 환각 꼼수) 강제 차단 및 재시도 유도
                            const koreanCharCount = (sanitizedText.match(/[가-힣]/g) || []).length;
                            if (koreanCharCount < 2) {
                                if (retries >= MAX_RETRIES - 1) {
                                    // 최종 재시도에서도 한글 부족이면 에러 대신 safe 처리 (분석 불가 기록)
                                    finalResult = { fileName, vulnerable: false, _note: 'hallucination_fallback_safe' };
                                    break;
                                }
                                throw new Error("English Hallucination Blocked (Insufficient Korean)");
                            }
                        }
                        
                        finalResult = parsedData;
                        break; // 성공 시 루프 탈출
                    } else {
                        throw new Error(`HTTP Error: ${response.status}`);
                    }
                } catch (error) {
                    retries++;
                    const errMsg = error.message || "Unknown error";
                    if (retries >= MAX_RETRIES) {
                        finalResult = { fileName, error: errMsg };
                        break;
                    }
                    // 재시도 대기 (Ollama 서버 안정화 대기용)
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            currentIndex++;
            activeFiles.delete(fileName);
            updateDisplay();
            return finalResult;
        };

        const queue = [...targetSrcFiles];
        
        const worker = async () => {
            while (queue.length > 0) {
                const file = queue.shift();
                const result = await processFile(file);
                
                // 디버그 로그에 모든 파일의 원시 분석 결과 기록 (투명성 확보)
                const kstTime = new Date(new Date().getTime() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
                fs.appendFileSync(DEBUG_LOG_FILE, `[${kstTime}] ${file}\nRESULT: ${JSON.stringify(result)}\n--------------------------------------------------\n`, 'utf8');

                // 통계 업데이트
                if (result.skipped) {
                    statsCount.skipped++;
                } else if (result.error) {
                    statsCount.error++;
                } else if (result.skipped_by_triage) {
                    // 사전 필터로 걸러진 파일은 모델이 본 적이 없으므로 safe 와 구분합니다.
                    statsCount.triaged++;
                } else if (result.vulnerable === false) {
                    statsCount.safe++;
                    modelJudgedThisRun++;
                } else if (result.vulnerable === true && result.vulnerabilityTypes) {
                    statsCount.vulnerable++;
                    modelJudgedThisRun++;
                    vulnerabilities.push(result);
                    // 실시간 저장 로직: 파일 하나가 끝날 때마다 JSON 리포트 갱신
                    finalReport.vulnerabilities = vulnerabilities;
                    writeReport(finalReport);
                } else {
                    statsCount.error++; // 포맷 불일치 등
                }
            }
        };

        // 지정된 동시 처리 수만큼 워커 실행
        const workers = Array(CONCURRENCY_LIMIT).fill(null).map(() => worker());
        await Promise.all(workers);

        clearInterval(displayInterval); // 모든 작업 완료 시 타이머 종료

        finalReport.vulnerabilities = vulnerabilities;
        // [FIX] 리포트만 보고 "취약점 0건 = 안전"으로 오인하지 않도록 실행 통계를 함께 기록합니다.
        finalReport.summary = {
            totalTargets: totalFiles,
            vulnerableFiles: statsCount.vulnerable,
            safe: statsCount.safe,
            error: statsCount.error,
            skippedBySize: statsCount.skipped,
            skippedByTriage: statsCount.triaged
        };
        writeReport(finalReport);

        // [FIX] 전 파일이 실패했다면 "완료"가 아니라 실패로 알려야 합니다.
        if (totalFiles > 0 && statsCount.error > 0 && modelJudgedThisRun === 0) {
            logger.error(`모델이 판정한 파일이 0개이고 ${statsCount.error}개가 실패했습니다. 리포트의 "취약점 0건"은 안전을 의미하지 않습니다.`);
            logger.error(`원인은 ${DEBUG_LOG_FILE} 의 error 항목을 확인하세요. Slack 알림은 전송하지 않습니다.`);
            process.exitCode = 1;
            return;
        }

        if (statsCount.error > 0) {
            logger.warn(`${statsCount.error}개 파일 분석에 실패했습니다. 해당 파일은 검사되지 않은 상태입니다.`);
        }
        logger.step(`모든 작업 완료! 리포트: ${REPORT_FILE} (취약 ${statsCount.vulnerable} / 안전 ${statsCount.safe} / 실패 ${statsCount.error} / 크기스킵 ${statsCount.skipped} / 사전필터 ${statsCount.triaged})`);

        // Slack Incoming Webhook으로 분석 결과 요약 전송
        await sendToSlack(finalReport);
    } catch (e) {
        logger.error(`치명적 오류: ${e.message}`);
    }
}

runReview();