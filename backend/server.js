'use strict';

/**
 * FlightGo Backend v2
 * ──────────────────────────────────────────────────────────────
 * 改用純 axios（無 Puppeteer），模擬真實瀏覽器行為：
 *   - 隨機 5~10 秒 rate limit（對 Trip.com）
 *   - 30 分鐘 in-memory 快取
 *   - 人性化 headers（UA、Referer、Accept-Language 等）
 *   - 啟動時預熱 session cookies
 *
 * 來源：
 *   1. Trip.com  — axios 取得 session cookies → SOA2 低價日曆 API
 *   2. Skyscanner — sky-scrapper RapidAPI getPriceCalendar（fallback）
 * ──────────────────────────────────────────────────────────────
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const PORT            = process.env.PORT            || 3000;
const RAPIDAPI_KEY    = process.env.RAPIDAPI_KEY    || '';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// ── 人性化 Headers ────────────────────────────────────────────
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ACCEPT_HEADERS = {
  'User-Agent':      BROWSER_UA,
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
};

// ── Rate Limiter（僅限 Trip.com）─────────────────────────────
const tripLimiter = {
  lastCall: 0,
  /** 隨機等待 5000~10000ms，確保不被視為機器人 */
  async throttle() {
    const now     = Date.now();
    const elapsed = now - this.lastCall;
    const wait    = 5000 + Math.random() * 5000;   // 5~10 秒
    if (elapsed < wait) {
      const sleep = wait - elapsed;
      console.log(`[Trip.com] rate limit：等待 ${(sleep / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, sleep));
    }
    this.lastCall = Date.now();
  },
};

// ── In-Memory 快取（30 分鐘）────────────────────────────────
const cache   = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// ── Trip.com Session Cookies（純 axios）──────────────────────
let tripSession = { cookies: '', updatedAt: 0, ttl: 60 * 60 * 1000 };

async function refreshTripSession() {
  console.log('[Trip.com] 取得新 session cookies...');
  try {
    // 先造訪首頁，像真實使用者一樣觸發 cookie 設定
    const resp = await axios.get('https://www.trip.com/flights/', {
      headers: {
        ...ACCEPT_HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      maxRedirects: 5,
      timeout: 20000,
    });

    const rawCookies = resp.headers['set-cookie'] || [];
    if (!rawCookies.length) throw new Error('未取得任何 cookies');

    // 只取 name=value 部分
    tripSession.cookies   = rawCookies.map(c => c.split(';')[0]).join('; ');
    tripSession.updatedAt = Date.now();
    console.log(`[Trip.com] ✅ session 取得成功（${rawCookies.length} 個 cookies）`);
    return tripSession.cookies;
  } catch (err) {
    console.error('[Trip.com] session 取得失敗:', err.message);
    return null;
  }
}

async function ensureTripSession() {
  if (!tripSession.cookies || Date.now() - tripSession.updatedAt > tripSession.ttl) {
    await refreshTripSession();
  }
  return tripSession.cookies;
}

// ── Trip.com 低價日曆 API ────────────────────────────────────
async function fetchTripPrice(from, to, date, adults) {
  const cacheKey = `trip:${from}:${to}:${date}:${adults}`;
  const cached   = getCached(cacheKey);
  if (cached) { console.log('[Trip.com] 命中快取'); return cached; }

  // rate limit：等待 5~10 秒再送請求
  await tripLimiter.throttle();

  const cookies = await ensureTripSession();
  if (!cookies) return null;

  try {
    const { data } = await axios.post(
      'https://m.ctrip.com/restapi/soa2/14427/getLowPriceInCalender',
      {
        Head: {
          Locale:   'zh_TW',
          Source:   'Online',
          Currency: 'TWD',
          SiteID:   2,
          ExtendFields: { DisableCalenderDefaultSetting: 'TRUE' },
        },
        dCity:         from,
        aCity:         to,
        flightWayType: 'OW',
        dDate:         date,
        cabinClass:    'y',
        adultCount:    adults,
        childCount:    0,
        babyCount:     0,
      },
      {
        headers: {
          ...ACCEPT_HEADERS,
          'Content-Type': 'application/json',
          'Accept':       'application/json, text/plain, */*',
          'Referer':      'https://www.trip.com/flights/',
          'Origin':       'https://www.trip.com',
          'Cookie':       cookies,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
        },
        timeout: 15000,
      }
    );

    const list = data?.lowPriceInCalenderDtoInfoList || [];
    if (!list.length) {
      console.warn('[Trip.com] 回傳空清單，session 可能失效');
      tripSession.updatedAt = 0;   // 強制下次更新
      return null;
    }

    const exact  = list.find(i => i.dDate === date);
    if (exact?.currencyPrice) {
      const result = { price: exact.currencyPrice, source: 'trip' };
      setCache(cacheKey, result);
      return result;
    }

    const nearby = list
      .filter(i => i.currencyPrice && i.dDate >= date)
      .sort((a, b) => a.dDate.localeCompare(b.dDate));
    if (nearby.length) {
      const result = { price: nearby[0].currencyPrice, source: 'trip' };
      setCache(cacheKey, result);
      return result;
    }
    return null;
  } catch (err) {
    console.error('[Trip.com] API 呼叫失敗:', err.message);
    tripSession.updatedAt = 0;
    return null;
  }
}

// ── Skyscanner getPriceCalendar（Fallback）───────────────────
async function fetchSkyPrice(from, to, date) {
  if (!RAPIDAPI_KEY) return null;

  const cacheKey = `sky:${from}:${to}:${date}`;
  const cached   = getCached(cacheKey);
  if (cached) { console.log('[Skyscanner] 命中快取'); return cached; }

  try {
    const [year, mon] = date.split('-');
    const { data } = await axios.get(
      'https://sky-scrapper.p.rapidapi.com/api/v1/flights/getPriceCalendar',
      {
        params: { originSkyId: from, destinationSkyId: to, fromDate: `${year}-${mon}-01`, currency: 'TWD' },
        headers: {
          'x-rapidapi-key':  RAPIDAPI_KEY,
          'x-rapidapi-host': 'sky-scrapper.p.rapidapi.com',
        },
        timeout: 10000,
      }
    );

    const days   = data?.data?.flights?.days || [];
    const exact  = days.find(d => d.day === date);
    if (exact?.price) {
      const result = { price: exact.price, source: 'skyscanner' };
      setCache(cacheKey, result);
      return result;
    }

    const nearby = days
      .filter(d => d.day >= date && d.price)
      .sort((a, b) => a.day.localeCompare(b.day));
    if (nearby.length) {
      const result = { price: nearby[0].price, source: 'skyscanner' };
      setCache(cacheKey, result);
      return result;
    }
    return null;
  } catch (err) {
    console.error('[Skyscanner] API 失敗:', err.message);
    return null;
  }
}

// ── Routes ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:             'ok',
    tripSession:        !!tripSession.cookies,
    tripSessionAge:     tripSession.updatedAt
                          ? Math.round((Date.now() - tripSession.updatedAt) / 1000) + 's'
                          : 'none',
    cacheSize:          cache.size,
    rapidApiConfigured: !!RAPIDAPI_KEY,
  });
});

/**
 * GET /api/price
 * Query: from, to, date (YYYY-MM-DD), adults (預設1), src (trip|sky|auto)
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
      result = await fetchTripPrice(from, to, date, parseInt(adults, 10));
    }
    if (!result && (src === 'sky' || src === 'auto')) {
      result = await fetchSkyPrice(from, to, date);
    }

    return res.json(result
      ? { ...result, currency: 'TWD' }
      : { price: null, currency: 'TWD', source: 'none' }
    );
  } catch (err) {
    console.error('[/api/price] 例外:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/session/refresh — 手動觸發 session 更新
 */
app.post('/api/session/refresh', async (req, res) => {
  tripSession.updatedAt = 0;
  const cookies = await ensureTripSession();
  res.json({ success: !!cookies });
});

// ── 啟動 ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✈  FlightGo backend v2 啟動於 port ${PORT}`);
  console.log(`   RapidAPI: ${RAPIDAPI_KEY ? '已設定' : '⚠ 未設定'}`);
  // 背景預熱 session（不阻塞啟動）
  ensureTripSession().catch(() => {});
});
