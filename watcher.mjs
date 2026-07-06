#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const STATE_FILE = new URL("./.cgv-watch-state.json", import.meta.url);
const AUTH_FILE = new URL("./.cgv-auth-headers.json", import.meta.url);
const BROWSER_PROFILE_DIR = new URL("./.cgv-browser-profile", import.meta.url);
const CGV_API_BASE = "https://api.cgv.co.kr/cnm/atkt/searchMovScnInfo";
const CGV_BOOKING_URL = "https://cgv.co.kr/cnm/movieBook/cinema";
const SCRIPT_VERSION = "2026-07-06.auto-header-refresh";

loadDotEnv();

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const calibrate = args.has("--calibrate");

const config = {
  movieAliases: listEnv("MOVIE_ALIASES", ["오디세이", "The Odyssey", "ODYSSEY"]),
  companyCode: env("COMPANY_CODE", "A420"),
  siteNo: env("SITE_NO", "0013"),
  rtctlScopCd: env("RTCTL_SCOP_CD", "08"),
  formatKeywords: listEnv("FORMAT_KEYWORDS", ["IMAX", "아이맥스"]),
  anyFormat: boolEnv("ANY_FORMAT", false),
  daysAhead: intEnv("DAYS_AHEAD", 14),
  startDate: env("START_DATE", ""),
  endDate: env("END_DATE", ""),
  intervalSeconds: intEnv("INTERVAL_SECONDS", 20),
  minIntervalSeconds: intEnv("MIN_INTERVAL_SECONDS", 15),
  maxIntervalSeconds: intEnv("MAX_INTERVAL_SECONDS", 300),
  timeoutMs: intEnv("TIMEOUT_MS", 8000),
  autoRefreshHeaders: boolEnv("AUTO_REFRESH_HEADERS", true),
  headerRefreshIntervalSeconds: intEnv("HEADER_REFRESH_INTERVAL_SECONDS", 600),
  headerCaptureTimeoutMs: intEnv("HEADER_CAPTURE_TIMEOUT_MS", 90000),
  browserHeadless: boolEnv("BROWSER_HEADLESS", false),
  theaterSearchName: env("THEATER_SEARCH_NAME", "용산아이파크몰"),
  cgvCookie: env("CGV_COOKIE", ""),
  cgvAuthorization: env("CGV_AUTHORIZATION", ""),
  extraHeadersJson: env("CGV_EXTRA_HEADERS_JSON", ""),
  telegramBotToken: env("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: env("TELEGRAM_CHAT_ID", "")
};

let state = readState();
let authHeaders = readAuthHeaders();
let lastHeaderRefreshAt = authHeaders.updatedAt ? Date.parse(authHeaders.updatedAt) : 0;
let currentInterval = clamp(
  config.intervalSeconds,
  config.minIntervalSeconds,
  config.maxIntervalSeconds
);
let consecutiveOk = 0;

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  printConfig();

  if (calibrate) {
    await runCalibration();
    return;
  }

  do {
    await refreshHeadersIfDue("scheduled");
    const result = await checkOnce();
    tuneInterval(result);

    if (once) break;
  } while (true);
}

async function checkOnce() {
  const dates = buildDates();
  let blocked = false;
  let authFailed = false;
  let transientError = false;
  let freshCount = 0;

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const url = buildScheduleUrl(date);
    try {
      await refreshHeadersIfDue("scheduled");
      let response = await fetchWithTimeout(url, config.timeoutMs);
      if (response.status === 401) {
        console.warn(`[auth] 401 Unauthorized on ${date}`);
        const refreshed = await refreshHeadersNow("401");
        if (refreshed) {
          console.log(`[auth] retrying ${date} with refreshed headers`);
          response = await fetchWithTimeout(url, config.timeoutMs);
        }
        if (response.status === 401) {
          authFailed = true;
          console.warn("[auth] CGV API still rejects the request after refresh.");
          break;
        }
      }
      if (isBlockStatus(response.status)) {
        blocked = true;
        console.warn(`[block?] ${response.status} ${response.statusText} on ${date}`);
        break;
      }
      if (!response.ok) {
        transientError = true;
        console.warn(`[warn] ${response.status} ${response.statusText} on ${date}`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      const body = await response.text();
      if (!contentType.includes("json") && looksLikeBlockPage(body)) {
        blocked = true;
        console.warn(`[block?] captcha/block-like response body on ${date}`);
        break;
      }

      const payload = parseJsonBody(body);
      const matches = parseMatches(payload, date);
      console.log(`[ok] ${date}: ${matches.length ? `${matches.length} candidate(s)` : "none"}`);

      const fresh = matches.filter((item) => !state.seen[item.signature]);
      if (fresh.length > 0) {
        for (const item of fresh) state.seen[item.signature] = new Date().toISOString();
        writeState(state);
        freshCount += fresh.length;
        console.log(`[notify] ${date}: ${fresh.length} new candidate(s). Sending now.`);
        await notify(fresh);
      }
    } catch (error) {
      transientError = true;
      console.warn(`[warn] ${date}: ${error.message}`);
    }

    if (!blocked && !authFailed && shouldWaitAfterDate(index, dates.length)) {
      await waitBeforeNextRequest();
    }
  }

  return { blocked, authFailed, transientError, freshCount };
}

async function runCalibration() {
  const candidates = [60, 45, 30, 20, 15].filter(
    (seconds) => seconds >= config.minIntervalSeconds
  );

  console.log("[calibrate] This is a conservative availability check, not a stress test.");
  console.log("[calibrate] It stops immediately if 403/429/503 or captcha-like HTML appears.");

  for (const seconds of candidates) {
    currentInterval = seconds;
    console.log(`[calibrate] trying ${seconds}s interval for 2 cycles`);

    for (let i = 0; i < 2; i += 1) {
      const result = await checkOnce();
      if (result.blocked) {
        console.log(`[calibrate] stop: ${seconds}s looks too aggressive. Use >= ${seconds * 2}s.`);
        return;
      }
      await sleep(seconds * 1000 + Math.floor(Math.random() * 1200));
    }
  }

  console.log("[calibrate] no obvious block signal detected in this short run.");
  console.log("[calibrate] Still keep INTERVAL_SECONDS conservative during real openings.");
}

function parseMatches(payload, date) {
  if (Number(payload?.statusCode) !== 0) {
    const message = payload?.statusMessage || "unknown API status";
    throw new Error(`CGV API returned non-zero status: ${message}`);
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((row) => isTargetMovie(row) && isTargetFormat(row) && isBookable(row))
    .map((row) => {
      const title = firstText(row.movNm, row.movEnm, row.prodNm, row.expoProdNm);
      const format = firstText(row.movkndDsplNm, row.tcscnsGradNm, row.scnsNm, row.scnsEnm);
      const time = formatTime(row.scnsrtTm);
      const seatsLeft = Number.parseInt(row.frSeatCnt || "0", 10);
      const screen = firstText(row.expoScnsNm, row.scnsNm, row.scnsEnm);

      return {
        date,
        time,
        title,
        format,
        screen,
        seatsLeft,
        url: CGV_BOOKING_URL,
        signature: [
          row.scnYmd || date,
          row.scnSseq,
          row.movNo,
          row.prodNo,
          row.scnsNo,
          row.scnsrtTm
        ].filter(Boolean).join("|")
      };
    });
}

async function notify(items) {
  const lines = [
    "CGV 용산아이파크몰 IMAX 예매 오픈 후보 감지",
    ...items.map((item) =>
      `- ${item.title} / ${item.format} / ${item.screen} / ${item.date} ${item.time} / 잔여 ${item.seatsLeft}석`
    ),
    items[0]?.url
  ].filter(Boolean);
  const message = lines.join("\n");

  console.log("\n" + message + "\n");
  process.stdout.write("\u0007");
  notifyMac("CGV IMAX 오픈 후보", message);

  if (config.telegramBotToken && config.telegramChatId) {
    await notifyTelegram(message);
  }
}

function notifyMac(title, message) {
  if (process.platform !== "darwin") return;
  execFile("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`
  ]);
}

async function notifyTelegram(message) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: config.telegramChatId,
    text: message,
    disable_web_page_preview: "true"
  });

  try {
    const response = await fetch(url, { method: "POST", body });
    if (!response.ok) {
      console.warn(`[telegram] ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.warn(`[telegram] ${error.message}`);
  }
}

function tuneInterval(result) {
  if (result.authFailed) {
    consecutiveOk = 0;
    console.log("[auth] interval unchanged. Header refresh did not produce a usable request yet.");
    return;
  }

  if (result.blocked) {
    currentInterval = Math.min(config.maxIntervalSeconds, currentInterval * 4);
    consecutiveOk = 0;
    console.log(`[backoff] block signal detected. interval -> ${currentInterval}s`);
    return;
  }

  if (result.transientError) {
    currentInterval = Math.min(config.maxIntervalSeconds, Math.ceil(currentInterval * 1.8));
    consecutiveOk = 0;
    console.log(`[backoff] transient error. interval -> ${currentInterval}s`);
    return;
  }

  consecutiveOk += 1;
  if (consecutiveOk >= 6 && currentInterval > config.intervalSeconds) {
    currentInterval = Math.max(config.intervalSeconds, Math.floor(currentInterval * 0.75));
    consecutiveOk = 0;
    console.log(`[recover] interval -> ${currentInterval}s`);
  }
}

function shouldWaitAfterDate(index, dateCount) {
  if (!once) return true;
  return index < dateCount - 1;
}

async function waitBeforeNextRequest() {
  const waitMs = Math.max(0, currentInterval * 1000);
  const jitterMs = Math.floor(Math.random() * Math.min(1000, waitMs * 0.1));
  console.log(`[wait] next API request in ${Math.round((waitMs + jitterMs) / 1000)}s`);
  await sleep(waitMs + jitterMs);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = buildHeaders();
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshHeadersIfDue(reason) {
  if (!config.autoRefreshHeaders) return false;
  const ageMs = Date.now() - lastHeaderRefreshAt;
  if (lastHeaderRefreshAt && ageMs < config.headerRefreshIntervalSeconds * 1000) {
    return false;
  }
  return refreshHeadersNow(reason);
}

async function refreshHeadersNow(reason) {
  if (!config.autoRefreshHeaders) return false;

  console.log(`[auth] refreshing CGV headers via browser (${reason})`);

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.warn("[auth] Playwright is not installed. Run: npm install && npx playwright install chromium");
    return false;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(fileURLToPath(BROWSER_PROFILE_DIR), {
      headless: config.browserHeadless,
      viewport: { width: 1280, height: 900 }
    });
    const capturedPromise = waitForCapturedRequest(context, config.headerCaptureTimeoutMs);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(CGV_BOOKING_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    await selectTheaterForHeaderCapture(page);

    const request = await capturedPromise;

    if (!request) {
      console.warn("[auth] Could not capture searchMovScnInfo automatically.");
      console.warn(`[auth] In the opened browser, select CGV ${config.theaterSearchName}/date once, then wait for capture.`);
      const manualRequest = await waitForCapturedRequest(context, config.headerCaptureTimeoutMs);
      if (!manualRequest) return false;
      return await storeCapturedHeaders(manualRequest);
    }

    return await storeCapturedHeaders(request);
  } catch (error) {
    console.warn(`[auth] browser header refresh failed: ${error.message}`);
    return false;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

async function selectTheaterForHeaderCapture(page) {
  console.log(`[auth] selecting theater: ${config.theaterSearchName}`);

  await openTheaterPickerIfNeeded(page);

  const searchInput = page
    .locator('input[placeholder*="극장명"], input[placeholder*="극장을"], input[type="search"], input')
    .first();
  await searchInput.waitFor({ state: "visible", timeout: 15000 });
  await searchInput.fill(config.theaterSearchName);
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(800);

  const exactResult = page.getByText(config.theaterSearchName, { exact: true }).last();
  if (await exactResult.isVisible({ timeout: 5000 }).catch(() => false)) {
    await exactResult.click();
    await page.waitForTimeout(1500);
    return;
  }

  const looseResult = page.getByText(config.theaterSearchName).last();
  if (await looseResult.isVisible({ timeout: 5000 }).catch(() => false)) {
    await looseResult.click();
    await page.waitForTimeout(1500);
    return;
  }

  const searchButton = page.locator('button:has-text("검색"), [aria-label*="검색"], svg').last();
  if (await searchButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchButton.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  const retryResult = page.getByText(config.theaterSearchName).last();
  if (await retryResult.isVisible({ timeout: 5000 }).catch(() => false)) {
    await retryResult.click();
    await page.waitForTimeout(1500);
    return;
  }

  console.warn(`[auth] Could not click theater automatically: ${config.theaterSearchName}`);
}

async function openTheaterPickerIfNeeded(page) {
  const alreadyOpen = await page
    .locator('input[placeholder*="극장명"], input[placeholder*="극장을"]')
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  if (alreadyOpen) return;

  const openers = [
    page.getByText("극장을 선택", { exact: false }).first(),
    page.getByText("선택 된 극장이 없습니다", { exact: false }).first(),
    page.locator('[aria-label*="극장"], button:has-text("+")').first()
  ];

  for (const opener of openers) {
    if (await opener.isVisible({ timeout: 2000 }).catch(() => false)) {
      await opener.click().catch(() => {});
      await page.waitForTimeout(800);
      break;
    }
  }
}

async function waitForCapturedRequest(context, timeoutMs) {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    context.on("request", (request) => {
      if (!request.url().startsWith(CGV_API_BASE)) return;
      clearTimeout(timeout);
      resolve(request);
    });
  });
}

async function storeCapturedHeaders(request) {
  const headers = await request.allHeaders();
  const nextAuthHeaders = extractUsableHeaders(headers);
  if (!nextAuthHeaders.extraHeaders["x-signature"] || !nextAuthHeaders.extraHeaders["x-timestamp"]) {
    console.warn("[auth] Captured request, but x-signature/x-timestamp was missing.");
    return false;
  }

  nextAuthHeaders.updatedAt = new Date().toISOString();
  authHeaders = nextAuthHeaders;
  lastHeaderRefreshAt = Date.now();
  writeFileSync(AUTH_FILE, JSON.stringify(authHeaders, null, 2));
  console.log(`[auth] captured fresh headers at ${authHeaders.updatedAt}`);
  return true;
}

function extractUsableHeaders(headers) {
  const extraHeaderNames = [
    "accept",
    "accept-language",
    "origin",
    "referer",
    "user-agent",
    "x-signature",
    "x-timestamp"
  ];
  const extraHeaders = {};

  for (const name of extraHeaderNames) {
    if (headers[name]) extraHeaders[name] = headers[name];
  }

  return {
    cookie: headers.cookie || "",
    authorization: headers.authorization || "",
    extraHeaders
  };
}

function buildHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
    "Origin": "https://cgv.co.kr",
    "Referer": CGV_BOOKING_URL,
    "Cache-Control": "no-cache"
  };

  const cookie = authHeaders.cookie || config.cgvCookie;
  const authorization = authHeaders.authorization || config.cgvAuthorization;

  if (cookie) headers.Cookie = cookie;
  if (authorization) headers.Authorization = authorization;

  return { ...headers, ...parseExtraHeaders(), ...(authHeaders.extraHeaders || {}) };
}

function buildScheduleUrl(date) {
  const params = new URLSearchParams({
    coCd: config.companyCode,
    siteNo: config.siteNo,
    scnYmd: date,
    rtctlScopCd: config.rtctlScopCd
  });
  return `${CGV_API_BASE}?${params.toString()}`;
}

function buildDates() {
  if (config.startDate && config.endDate) {
    return dateRange(config.startDate, config.endDate);
  }

  const dates = [];
  const now = new Date();
  for (let i = 0; i <= config.daysAhead; i += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    dates.push(formatYmd(date));
  }
  return dates;
}

function dateRange(startYmd, endYmd) {
  const dates = [];
  const cursor = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  while (cursor <= end) {
    dates.push(formatYmd(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function parseYmd(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}. Use YYYYMMDD.`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatYmd(date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("CGV API response was not JSON");
  }
}

function isTargetMovie(row) {
  const text = [
    row.movNm,
    row.movEnm,
    row.prodNm,
    row.expoProdNm,
    row.engProdNm
  ].filter(Boolean).join(" ").toLowerCase();

  return config.movieAliases.some((alias) => text.includes(alias.toLowerCase()));
}

function isTargetFormat(row) {
  if (config.anyFormat) return true;

  const text = [
    row.movkndDsplNm,
    row.movkndDsplEnm,
    row.tcscnsGradNm,
    row.scnsNm,
    row.expoScnsNm,
    row.scnsEnm
  ].filter(Boolean).join(" ").toLowerCase();

  return config.formatKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function isBookable(row) {
  if (row.cntlYn === "Y") return false;
  const seatsLeft = Number.parseInt(row.frSeatCnt || "0", 10);
  return Number.isFinite(seatsLeft) && seatsLeft > 0;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function formatTime(value) {
  if (!value || value.length !== 4) return value || "time-unknown";
  return `${value.slice(0, 2)}:${value.slice(2)}`;
}

function looksLikeBlockPage(text) {
  const lowered = text.toLowerCase();
  return ["captcha", "access denied", "forbidden", "too many requests"].some((word) =>
    lowered.includes(word)
  );
}

function isBlockStatus(status) {
  return [403, 429, 503].includes(status);
}

function parseExtraHeaders() {
  if (!config.extraHeadersJson) return {};

  try {
    const parsed = JSON.parse(config.extraHeadersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CGV_EXTRA_HEADERS_JSON must be a JSON object");
    }
    return parsed;
  } catch (error) {
    console.warn(`[config] ignoring CGV_EXTRA_HEADERS_JSON: ${error.message}`);
    return {};
  }
}

function readState() {
  if (!existsSync(STATE_FILE)) return { seen: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { seen: {} };
  }
}

function writeState(nextState) {
  writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}

function readAuthHeaders() {
  if (!existsSync(AUTH_FILE)) return { cookie: "", authorization: "", extraHeaders: {} };
  try {
    const parsed = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    return {
      cookie: parsed.cookie || "",
      authorization: parsed.authorization || "",
      extraHeaders: parsed.extraHeaders || {},
      updatedAt: parsed.updatedAt || ""
    };
  } catch {
    return { cookie: "", authorization: "", extraHeaders: {} };
  }
}

function loadDotEnv() {
  const envPath = new URL("./.env", import.meta.url);
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function printConfig() {
  console.log("[config]", {
    version: SCRIPT_VERSION,
    notifyMode: "per-date-immediate",
    movieAliases: config.movieAliases,
    companyCode: config.companyCode,
    siteNo: config.siteNo,
    rtctlScopCd: config.rtctlScopCd,
    formatKeywords: config.formatKeywords,
    anyFormat: config.anyFormat,
    dates: config.startDate && config.endDate
      ? `${config.startDate}-${config.endDate}`
      : `today+${config.daysAhead}`,
    intervalSeconds: config.intervalSeconds,
    minIntervalSeconds: config.minIntervalSeconds,
    maxIntervalSeconds: config.maxIntervalSeconds,
    autoRefreshHeaders: config.autoRefreshHeaders,
    headerRefreshIntervalSeconds: config.headerRefreshIntervalSeconds,
    browserHeadless: config.browserHeadless,
    theaterSearchName: config.theaterSearchName,
    hasCookie: Boolean(authHeaders.cookie || config.cgvCookie),
    hasAuthorization: Boolean(authHeaders.authorization || config.cgvAuthorization),
    hasExtraHeaders: Boolean(Object.keys(authHeaders.extraHeaders || {}).length || config.extraHeadersJson),
    authUpdatedAt: authHeaders.updatedAt || null
  });
}

function env(key, fallback) {
  return process.env[key] || fallback;
}

function intEnv(key, fallback) {
  const value = Number.parseInt(process.env[key] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(key, fallback) {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
}

function listEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
