# CGV 용산 IMAX 오픈 감지 스크립트

CGV 용산아이파크몰 IMAX 상영시간표 API에서 특정 영화가 보이는지 감지하고, 새 후보가 생기면 맥 알림/터미널 소리/텔레그램으로 알려주는 작은 Node.js 스크립트입니다.

자동 예매가 아니라 오픈 감지만 합니다.

## 빠른 실행

```bash
cd /workspace/cgv-imax-watch
cp .env.example .env
node watcher.mjs --once
node watcher.mjs
```

## 401 Unauthorized가 뜰 때

`401 Unauthorized`는 영화명 검색 실패가 아니라, CGV API가 Node 요청을 인증되지 않은 요청으로 거절한 것입니다.

기본값은 브라우저 기반 자동 갱신입니다. 스크립트가 실제 브라우저를 열고 `searchMovScnInfo` 요청을 캡처해서 `cookie`, `x-signature`, `x-timestamp`를 `.cgv-auth-headers.json`에 저장합니다. 이후 Node 요청은 이 최신 값을 사용합니다.

```bash
AUTO_REFRESH_HEADERS=true
HEADER_REFRESH_INTERVAL_SECONDS=600
HEADER_CAPTURE_TIMEOUT_MS=90000
BROWSER_HEADLESS=false
THEATER_SEARCH_NAME=용산아이파크몰
```

처음 실행 시 브라우저가 열리면 스크립트가 극장 검색창에 `THEATER_SEARCH_NAME` 값을 입력하고 결과를 클릭해 `searchMovScnInfo` 요청을 발생시키려고 시도합니다. 캡처되면 터미널에 아래처럼 표시됩니다.

```text
[auth] captured fresh headers at ...
```

만약 자동 클릭이 실패하면 열린 브라우저에서 CGV 용산아이파크몰/날짜를 한 번 직접 선택해 주세요. 그 요청이 발생하는 순간 헤더가 캡처됩니다.

Playwright가 설치되어 있지 않으면 아래를 한 번 실행하세요.

```bash
npm install
npx playwright install chromium
```

수동으로 넣고 싶을 때는 Chrome에서 실제 요청 헤더를 복사해 `.env`에 넣을 수도 있습니다.

1. Chrome에서 `https://cgv.co.kr/cnm/movieBook/cinema`를 엽니다.
2. 개발자도구 > Network를 엽니다.
3. 날짜/극장을 선택해서 `searchMovScnInfo` 요청이 뜨게 합니다.
4. 해당 요청의 Request Headers에서 필요한 값을 `.env`에 넣습니다.

우선 `cookie`가 있으면 아래처럼 넣어보세요.

```bash
CGV_COOKIE=복사한_cookie_전체
```

`authorization` 헤더가 있으면 `Bearer ...`까지 포함해서 넣습니다.

```bash
CGV_AUTHORIZATION=Bearer ...
```

그 외 필수처럼 보이는 헤더가 있으면 JSON으로 추가할 수 있습니다.

```bash
CGV_EXTRA_HEADERS_JSON={"x-some-header":"value"}
```

## 현재 상영작으로 테스트

현재 상영작이 IMAX가 아닐 수도 있으니, API 연결 자체를 먼저 확인할 때는 포맷 필터를 잠깐 끌 수 있습니다.

```bash
MOVIE_ALIASES=호프
ANY_FORMAT=true
node watcher.mjs --once
```

IMAX만 확인하려면 다시 아래처럼 둡니다.

```bash
ANY_FORMAT=false
FORMAT_KEYWORDS=IMAX,아이맥스
```

## 날짜 범위 좁히기

용아맥 오픈 감지는 날짜를 넓게 훑을수록 요청 수가 늘어납니다. `.env`에서 개봉일 근처만 잡는 것을 권장합니다.

```bash
START_DATE=20260715
END_DATE=20260731
```

날짜 범위를 지정하지 않으면 `DAYS_AHEAD` 값만큼 오늘부터 확인합니다.

## 차단 징후 확인

```bash
npm run calibrate
```

`calibrate`는 60초, 45초, 30초, 20초, 15초 간격을 짧게만 확인합니다. 부하 테스트가 아니라 보수적인 상태 확인이며, `403`, `429`, `503`, captcha 같은 차단 징후가 보이면 즉시 멈춥니다.

## 동작 방식

스크립트는 설정한 날짜 범위를 하루씩 순서대로 조회합니다. 한 날짜에서 새 회차가 발견되면 전체 날짜 탐색이 끝날 때까지 기다리지 않고 즉시 알림을 보냅니다.

`INTERVAL_SECONDS`는 전체 날짜 범위를 한 바퀴 돈 뒤 쉬는 시간이 아니라, API 요청 하나와 다음 API 요청 사이의 간격입니다.

예를 들어 아래처럼 설정하면:

```bash
START_DATE=20260715
END_DATE=20260717
INTERVAL_SECONDS=20
```

실제 흐름은 대략 이렇게 됩니다.

```text
20260715 조회
20초 대기
20260716 조회
20초 대기
20260717 조회
20초 대기
20260715 다시 조회
```

## 알림

macOS에서는 감지 시 데스크톱 알림과 터미널 소리가 납니다.

텔레그램도 쓰고 싶으면 `.env`에 아래 값을 넣으세요.

```bash
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_CHAT_ID=123456789
```

## 기본값

```bash
MOVIE_ALIASES=오디세이,The Odyssey,ODYSSEY
COMPANY_CODE=A420
SITE_NO=0013
RTCTL_SCOP_CD=08
FORMAT_KEYWORDS=IMAX,아이맥스
ANY_FORMAT=false
INTERVAL_SECONDS=20
MIN_INTERVAL_SECONDS=15
MAX_INTERVAL_SECONDS=300
AUTO_REFRESH_HEADERS=true
HEADER_REFRESH_INTERVAL_SECONDS=600
THEATER_SEARCH_NAME=용산아이파크몰
```

현재 요청 URL은 아래 형태입니다.

```text
https://api.cgv.co.kr/cnm/atkt/searchMovScnInfo?coCd=A420&siteNo=0013&scnYmd=20260711&rtctlScopCd=08
```

예매 페이지는 `https://cgv.co.kr/cnm/movieBook/cinema` 고정 URL로 알림에 포함합니다.

## 주의

간격을 지나치게 줄이면 IP나 계정이 차단될 수 있습니다. 실제 오픈 대기 중에는 날짜 범위를 좁히고, `INTERVAL_SECONDS=20` 이하로 무리하게 내리지 않는 쪽을 권장합니다.
