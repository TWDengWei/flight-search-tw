/**
 * FlightGo Backend
 * ─────────────────────────────────────────────────────────────────
 * 提供兩個價格來源：
 *   1. Trip.com  — Puppeteer stealth 取得真實 session cookies，
 *                  再呼叫 SOA2 低價日曆 API
 *   2. Skyscanner — sky-scrapper RapidAPI getPriceCalendar（確認可用）
 *
 * 部署方式：Render / Railway / 任何支援 Node.js 18+ 的平台
 * 環境變數：
 *   PORT            - 監聽埠（預設 3000）
 *   RAPIDAPI_KEY    - sky-scrapper RapidAPI key
 *   FRONTEND_ORIGIN - 前端 URL（CORS 白名單，預設 *）
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const puppeteer  = require('puppeteer-extra');
const Stealth    = require('puppeteer-extra-plugin-stealth');

puppeteer.use(Stealth());

// ── 環境變數 ──────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3000;
const RAPIDAPI_KEY    = process.env.RAPIDAPI_KEY    || '';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

// ── Express 設定 ──────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// ── Trip.com Session 管理 ─────────────────────────────────────────
let tripSession = {
  cookies: null,
  updatedAt: 0,
  ttl: 30 * 60 * 1000   // 30 分鐘後更新
};

/**
 * 使用 Puppeteer stealth 取得 Trip.com session cookies
 * 包括 PerimeterX sec_cpt token、GUID 等
 */
async function refreshTripSession() {
  console.log('[Trip.com] 🚀 啟動 Puppeteer 取得 session...');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    const page = await browser.newPage();

    // 設定真實 User-Agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // 訪問 Trip.com 首頁，觸發 JS challenge
    await page.goto('https://www.trip.com/flights/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 等待 PerimeterX challenge 完成（最多 10 秒）
    await page.waitForTimeout(3000);

    // 抓取所有 cookies
    const pageCookies = await page.cookies('https://www.trip.com');
    const mCookies    = await page.cookies('https://m.ctrip.com').catch(() => []);
    const allCookies  = [...pageCookies, ...mCookies];

    if (allCookies.length === 0) throw new Error('未取得任何 cookies');

    tripSession.cookies  = allCookies;
    tripSession.updatedAt = Date.now();
    console.log(`[Trip.com] ✅ session 取得成功（${allCookies.length} 個 cookies）`);
    return allCookies;
  } catch (err) {
    console.error('[Trip.com] ❌ session 取得失敗:', err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/** 確保 session 有效，需要時自動更新 */
async function ensureTripSession() {
  if (!tripSession.cookies || Date.now() - tripSession.updatedAt > tripSession.ttl) {
    await refreshTripSession();
  }
  return tripSession.cookies;
}

/** 將 Puppeteer cookies 轉成 axios Cookie header 字串 */
function cookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ── Trip.com 低價日曆 API ─────────────────────────────────────────
async function fetchTripPrice(from, to, date, adults) {
  const cookies = await ensureTripSession();
  if (!cookies) return null;

  const guid = cookies.find(c => c.name === 'GUID')?.value || '';

  try {
    const { data } = await axios.post(
      'https://m.ctrip.com/restapi/soa2/14427/getLowPriceInCalender',
      {
        Head: {
          Locale:   'zh_TW',
          Source:   'Online',
          Currency: 'TWD',
          SiteID:   2,
          CPID:     guid.substring(0, 5) || '09031',
          CID:      `C_${guid}`,
          ClientID: guid,
          ExtendFields: { DisableCalenderDefaultSetting: 'TRUE' }
        },
        dCity:          from,
        aCity:          to,
        flightWayType: 'OW',
        dDate:          date,
        cabinClass:     'y',
        adultCount:     adults,
        childCount:     0,
        babyCount:      0
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
          'Referer':      'https://m.ctrip.com/webapp/flight/',
          'Cookie':       cookieHeader(cookies)
        },
        timeout: 10000
      }
    );

    const list = data?.lowPriceInCalenderDtoInfoList || [];
    if (!list.length) {
      console.warn('[Trip.com] API 回傳空清單，可能 session 失效 → 強制更新');
      tripSession.updatedAt = 0;  // 強制下次更新
      return null;
    }

    const exact  = list.find(i => i.dDate === date);
    if (exact?.currencyPrice) return { price: exact.currencyPrice, source: 'trip' };

    const nearby = list
      .filter(i => i.currencyPrice && i.dDate >= date)
      .sort((a, b) => a.dDate.localeCompare(b.dDate));
    if (nearby.length) return { price: nearby[0].currencyPrice, source: 'trip' };
    return null;
  } catch (err) {
    console.error('[Trip.com] API 呼叫失敗:', err.message);
    tripSession.updatedAt = 0;  // 強制下次更新
    return null;
  }
}

// ── sky-scrapper getPriceCalendar ─────────────────────────────────
async function fetchSkyPrice(from, to, date) {
  if (!RAPIDAPI_KEY) return null;
  try {
    const [year, mon] = date.split('-');
    const fromDate = `${year}-${mon}-01`;

    const { data } = await axios.get(
      'https://sky-scrapper.p.rapidapi.com/api/v1/flights/getPriceCalendar',
      {
        params: { originSkyId: from, destinationSkyId: to, fromDate, currency: 'TWD' },
        headers: {
          'x-rapidapi-key':  RAPIDAPI_KEY,
          'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com'
        },
        timeout: 10000
      }
    );

    const days   = data?.data?.flights?.days || [];
    const exact  = days.find(d => d.day === date);
    if (exact?.price) return { price: exact.price, source: 'skyscanner' };

    const nearby = days
      .filter(d => d.day >= date && d.price)
      .sort((a, b) => a.day.localeCompare(b.day));
    if (nearby.length) return { price: nearby[0].price, source: 'skyscanner' };
    return null;
  } catch (err) {
    console.error('[sky-scrapper] API 失敗:', err.message);
    return null;
  }
}

// ── Routes ────────────────────────────────────────────────────────

/** GET /health — 健康檢查 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tripSession: !!tripSession.cookies,
    tripSessionAge: tripSession.updatedAt
      ? Math.round((Date.now() - tripSession.updatedAt) / 1000) + 's'
      : 'none',
    rapidApiConfigured: !!RAPIDAPI_KEY
  });
});

/**
 * GET /api/price
 * Query params: from, to, date, adults (預設1), src (trip|sky|auto，預設auto)
 * Response: { price, currency, source }
 */
app.get('/api/price', async (req, res) => {
  const { from, to, date, adults = '1', src = 'auto' } = req.query;

  if (!from || !to || !date) {
    return res.status(400).json({ error: '缺少必要參數: from, to, date' });
  }

  console.log(`[/api/price] ${from}→${to} ${date} adults=${adults} src=${src}`);

  try {
    let result = null;

    if (src === 'trip' || src === 'auto') {
      result = await fetchTripPrice(from, to, date, parseInt(adults));
    }

    if (!result && (src === 'sky' || src === 'auto')) {
      result = await fetchSkyPrice(from, to, date);
    }

    if (!result) {
      return res.json({ price: null, currency: 'TWD', source: 'none' });
    }

    return res.json({ ...result, currency: 'TWD' });
  } catch (err) {
    console.error('[/api/price] 例外:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/session/refresh — 手動觸發 session 更新（管理用）
 */
app.post('/api/session/refresh', async (req, res) => {
  tripSession.updatedAt = 0;
  const cookies = await ensureTripSession();
  res.json({
    success: !!cookies,
    cookieCount: cookies?.length || 0,
    hasGuid: cookies?.some(c => c.name === 'GUID') || false
  });
});

// ── 啟動 ──────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✈  FlightGo backend 啟動於 port ${PORT}`);
  console.log(`   RapidAPI key: ${RAPIDAPI_KEY ? '已設定' : '⚠ 未設定'}`);
  // 啟動時預先取得 Trip.com session（背景執行，不阻塞啟動）
  ensureTripSession().catch(() => {});
});
