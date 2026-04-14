'use strict';

/**
 * FlightGo Backend v3
 * ──────────────────────────────────────────────────────────────
 * 使用 Trip.com 真實搜尋端點：
 *
 *   主要：FlightListSearchSSE (soa2/27015)
 *     - 真實航班列表，即時庫存價格（SSE streaming）
 *     - 對應 Trip.com 網站搜尋結果頁面使用的端點
 *
 *   備援：GetLowPriceInCalender (soa2/14427) on www.trip.com
 *     - 日期範圍最低價日曆（非即時庫存）
 *     - 僅作為 fallback
 *
 *   差異修正（v2 vs v3）：
 *     1. 主端點從 getLowPriceInCalender → FlightListSearchSSE
 *     2. 域名從 m.ctrip.com → www.trip.com
 *     3. Source: "Online" → "ONLINE"
 *     4. cabinClass: "y" → "Economy"
 *     5. 乘客格式: adultCount → passengerInfoType.adultCount
 *     6. SSE 回應解析：data: prefix，itineraryList 結構
 *
 * 來源：
 *   1. Trip.com FlightListSearchSSE — 即時搜尋（主要）
 *   2. Trip.com GetLowPriceInCalender — 日曆最低價（fallback）
 *   3. Skyscanner getPriceCalendar — RapidAPI（最後備援）
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

// ── Rate Limiter（Trip.com 搜尋端點）────────────────────────
const tripLimiter = {
  lastCall: 0,
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

// ── Trip.com Session Cookies ──────────────────────────────────
let tripSession = { cookies: '', updatedAt: 0, ttl: 60 * 60 * 1000 };

async function refreshTripSession() {
  console.log('[Trip.com] 取得新 session cookies...');
  try {
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

// ── 機場碼 → 城市碼映射（Trip.com SSE 使用城市碼）───────────
// Trip.com SSE 的 arriveCode/departCode 使用城市碼，才能搜出所有機場航班
// 例如：NRT/HND → TYO（東京所有機場），若搜 NRT 只回傳成田班次
const AIRPORT_TO_CITY = {
  // 日本
  NRT: 'TYO', HND: 'TYO',              // 東京
  KIX: 'OSA', ITM: 'OSA',              // 大阪
  // 韓國
  ICN: 'SEL', GMP: 'SEL',              // 首爾
  // 中國
  PVG: 'SHA', SHA: 'SHA',              // 上海
  PEK: 'BJS', PKX: 'BJS',             // 北京
  // 歐洲
  CDG: 'PAR', ORY: 'PAR',             // 巴黎
  LHR: 'LON', LGW: 'LON', LCY: 'LON', // 倫敦
  FRA: 'FRA',
  // 美國
  JFK: 'NYC', LGA: 'NYC', EWR: 'NYC', // 紐約
  LAX: 'LAX',
  // 台灣（城市碼與機場碼相同）
  TPE: 'TPE', TSA: 'TPE',
  // 東南亞
  BKK: 'BKK', DMK: 'BKK',             // 曼谷
  SIN: 'SIN',                           // 新加坡
  KUL: 'KUL',                           // 吉隆坡
  HKG: 'HKG',                           // 香港
};

function toCityCode(iata) {
  return AIRPORT_TO_CITY[iata?.toUpperCase()] || iata;
}

// ── 產生 head 結構（Trip.com API 共用）───────────────────────
// 盡量模擬真實瀏覽器請求，包含 vid、Flt_SessionId、abtList 等欄位
function makeTripHead(currency = 'TWD', locale = 'en-XX') {
  const now       = new Date();
  const clientTime = now.toISOString().replace('Z', '+08:00').slice(0, 22) + ':00';
  const txId      = `1-mf-${now.toISOString().replace(/[-:T.Z]/g,'').slice(0,17)}-WEB`;
  const batchId   = 'b' + Math.random().toString(36).slice(2, 10) + '-' + Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 14);

  return {
    cid:     '09034133310159917369',
    ctok:    '',
    cver:    '3',
    lang:    '01',
    sid:     '8888',
    syscode: '40',
    auth:    '',
    xsid:    '',
    extension: [
      { name: 'source',                      value: 'ONLINE' },
      { name: 'sotpGroup',                   value: 'Trip' },
      { name: 'sotpLocale',                  value: locale },
      { name: 'sotpCurrency',                value: currency },
      { name: 'allianceID',                  value: '0' },
      { name: 'sid',                         value: '0' },
      { name: 'ouid',                        value: '' },
      { name: 'uuid' },
      { name: 'useDistributionType',         value: '1' },
      { name: 'flt_app_session_transactionId', value: txId },
      { name: 'vid',                         value: '1775977831097.ff58JInrFyuC' },
      { name: 'pvid',                        value: '3' },
      { name: 'Flt_SessionId',               value: '5' },
      { name: 'channel' },
      { name: 'x-ua',                        value: 'v=3_os=ONLINE_osv=10' },
      { name: 'PageId',                      value: '10320667452' },
      { name: 'clientTime',                  value: clientTime },
      { name: 'Flt_BatchId',                 value: batchId },
      { name: 'BlockTokenTimeout',           value: '0' },
      { name: 'full_link_time_scene',        value: 'pure_list_page' },
      { name: 'xproduct',                    value: 'baggage' },
      { name: 'units',                       value: 'METRIC' },
      { name: 'sotpUnit',                    value: 'METRIC' },
    ],
    Locale:   locale,
    Language: locale.split('-')[0],
    Currency: currency,
    ClientID: '',
    appid:    '700020',
  };
}

// A/B 測試清單（來自真實瀏覽器，影響可用艙等/促銷顯示）
const TRIP_ABT_LIST = [
  { abCode: '250811_IBU_wjrankol',   abVersion: 'A' },
  { abCode: '251023_IBU_pricetool',  abVersion: 'A' },
  { abCode: '260302_IBU_farecardjc', abVersion: 'B' },
];

// ── 主要：FlightListSearchSSE ─────────────────────────────────
// Trip.com 真實搜尋端點，回傳即時航班列表（SSE streaming）
async function fetchTripFlightList(from, to, date, adults) {
  const cacheKey = `sse:${from}:${to}:${date}:${adults}`;
  const cached   = getCached(cacheKey);
  if (cached) { console.log('[FlightListSearchSSE] 命中快取'); return cached; }

  await tripLimiter.throttle();

  const cookies = await ensureTripSession();

  try {
    const { data: rawText } = await axios.post(
      'https://www.trip.com/restapi/soa2/27015/FlightListSearchSSE',
      {
        mode: 0,
        searchCriteria: {
          grade:        3,
          realGrade:    1,
          tripType:     1,
          journeyNo:    1,
          passengerInfoType: {
            adultCount:  adults,
            childCount:  0,
            infantCount: 0,
          },
          journeyInfoTypes: [{
            journeyNo:    1,
            departDate:   date,
            departCode:   toCityCode(from),  // 使用城市碼（如 TPE），搜出所有機場
            arriveCode:   toCityCode(to),    // 使用城市碼（如 TYO 含 NRT+HND）
            departAirport: '',
            arriveAirport: '',
          }],
          policyId: null,
        },
        sortInfoType:  { direction: true, orderBy: 'Direct', topList: [] },
        tagList:       [],
        flagList:      ['NEED_RESET_SORT'],
        filterType:    { filterFlagTypes: [], queryItemSettings: [], studentsSelectedStatus: true },
        abtList:       TRIP_ABT_LIST,
        head:          makeTripHead('TWD'),
      },
      {
        headers: {
          ...ACCEPT_HEADERS,
          'Content-Type': 'application/json',
          'Accept':       'text/event-stream, application/json, */*',
          'Referer':      `https://www.trip.com/flights/`,
          'Origin':       'https://www.trip.com',
          ...(cookies ? { 'Cookie': cookies } : {}),
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        // SSE 回應是純文字
        responseType: 'text',
        timeout: 25000,
      }
    );

    // SSE 格式：多段資料以 "data:" 開頭，每段可能包含 itineraryList
    // SearchType="FIRST" 表示第一批結果，後續 chunk 可能含更多航班（含促銷/低艙）
    // 需合併所有 chunk 的 itineraryList 以取得完整結果（含 IT202 等）
    const rawStr = typeof rawText === 'string' ? rawText : String(rawText);
    const blocks = rawStr.split('\n\n');
    const allItineraries = [];
    let chunkCount = 0;

    for (const block of blocks) {
      if (!block.startsWith('data:')) continue;
      try {
        const chunk = JSON.parse(block.slice(5).trim());
        if (chunk.itineraryList && chunk.itineraryList.length) {
          allItineraries.push(...chunk.itineraryList);
          chunkCount++;
          console.log(`[SSE] chunk #${chunkCount} SearchType=${chunk.searchType} itineraries=${chunk.itineraryList.length} total=${allItineraries.length}`);
        }
      } catch (_) {}
    }

    if (!allItineraries.length) {
      console.warn('[FlightListSearchSSE] 回傳空航班，session 可能失效');
      tripSession.updatedAt = 0;
      return null;
    }

    console.log(`[SSE] 共解析 ${chunkCount} 個 chunk，合計 ${allItineraries.length} 筆航班`);

    // 解析航班列表，每個航班取最便宜的政策（policy）
    // 注意：同一航班可能有多個 policy（不同艙等/含行李/促銷等），取最低 totalPrice
    // 注意：連線航班（如 TPE→SIN→NRT）transSectionList 有多段，
    //   - 第一段（[0]）的 arrivePoint 是中繼站（如 SIN）
    //   - 最後一段（[-1]）的 arrivePoint 才是最終目的地（如 NRT）
    const flights = allItineraries.map(item => {
      const sections = item.journeyList?.[0]?.transSectionList || [];
      const firstSeg = sections[0];                       // 首段（含出發資訊、航班號）
      const lastSeg  = sections[sections.length - 1];    // 末段（含最終到達機場）
      const policies = item.policies || [];
      const stops    = Math.max(0, sections.length - 1); // 中轉次數

      // 找出最低票價的 policy
      const cheapestPolicy = policies
        .filter(p => p?.price?.totalPrice > 0)
        .sort((a, b) => a.price.totalPrice - b.price.totalPrice)[0];

      if (!cheapestPolicy || !firstSeg) return null;
      return {
        flightNo:   firstSeg?.flightInfo?.flightNo,
        airline:    firstSeg?.flightInfo?.airlineCode,
        depTime:    firstSeg?.departDateTime,
        arrTime:    lastSeg?.arriveDateTime,              // 最終到達時間
        depAirport: firstSeg?.departPoint?.airportCode,
        arrAirport: lastSeg?.arrivePoint?.airportCode,   // 最終目的機場
        stops,
        price:      cheapestPolicy.price.totalPrice,
        adultFare:  cheapestPolicy.price?.adult?.salePrice,
        tax:        cheapestPolicy.price?.totalTax,
        policyId:   cheapestPolicy.policyId,
      };
    }).filter(f => f && f.price > 0);

    if (!flights.length) return null;

    // 取最低價航班
    flights.sort((a, b) => a.price - b.price);
    const cheapest = flights[0];

    const result = {
      price:      cheapest.price,
      adultFare:  cheapest.adultFare,
      tax:        cheapest.tax,
      flightNo:   cheapest.flightNo,
      depTime:    cheapest.depTime,
      arrTime:    cheapest.arrTime,
      depAirport: cheapest.depAirport,
      arrAirport: cheapest.arrAirport,
      allFlights: flights,     // 完整航班列表
      source:     'trip_sse',
    };
    setCache(cacheKey, result);
    return result;

  } catch (err) {
    console.error('[FlightListSearchSSE] 呼叫失敗:', err.message);
    tripSession.updatedAt = 0;
    return null;
  }
}

// ── 備援：GetLowPriceInCalender (www.trip.com) ───────────────
// 注意：此 API 回傳日期範圍的最低價，非即時庫存價，可能有落差
async function fetchTripCalendar(from, to, date, adults) {
  const cacheKey = `cal:${from}:${to}:${date}:${adults}`;
  const cached   = getCached(cacheKey);
  if (cached) { console.log('[GetLowPriceInCalender] 命中快取'); return cached; }

  await tripLimiter.throttle();

  const cookies = await ensureTripSession();
  if (!cookies) return null;

  try {
    const { data } = await axios.post(
      'https://www.trip.com/restapi/soa2/14427/GetLowPriceInCalender',
      {
        dCity:            from,
        aCity:            to,
        dDate:            date,
        flightWayType:    'OW',
        departureAirport: '',
        arrivalAirport:   '',
        cabinClass:       'Economy',       // 修正：原為 "y"
        transferType:     'ANY',
        searchInfo:       { travelerNum: { adult: adults, child: 0, infant: 0 } },
        abtList:          [],
        offSet:           0,
        Head: {
          Group:       'Trip',
          Source:      'ONLINE',           // 修正：原為 "Online"
          Version:     '3',
          Currency:    'TWD',
          Locale:      'zh-TW',
          AllianceInfo: { AllianceID: 0, SID: 0, OuID: '', UseDistributionType: 1 },
          TransactionID: `1-mf-${Date.now()}-WEB`,
          ExtendFields: { PageId: '10320667452', Os: 'Windows', OsVersion: '10' },
          ClientID:    '09034133310159917369',
        },
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
          'Sec-Fetch-Site': 'same-origin',
        },
        timeout: 15000,
      }
    );

    const list = data?.lowPriceInCalenderDtoInfoList || [];
    if (!list.length) {
      console.warn('[GetLowPriceInCalender] 回傳空清單');
      tripSession.updatedAt = 0;
      return null;
    }

    const exact  = list.find(i => i.dDate === date);
    if (exact?.currencyPrice) {
      const result = { price: exact.currencyPrice, source: 'trip_calendar' };
      setCache(cacheKey, result);
      return result;
    }

    const nearby = list
      .filter(i => i.currencyPrice && i.dDate >= date)
      .sort((a, b) => a.dDate.localeCompare(b.dDate));
    if (nearby.length) {
      const result = { price: nearby[0].currencyPrice, source: 'trip_calendar' };
      setCache(cacheKey, result);
      return result;
    }
    return null;
  } catch (err) {
    console.error('[GetLowPriceInCalender] 呼叫失敗:', err.message);
    tripSession.updatedAt = 0;
    return null;
  }
}

// ── 備援：Skyscanner getPriceCalendar ────────────────────────
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
    version:            'v3',
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
 * Query: from, to, date (YYYY-MM-DD), adults (預設1), src (sse|calendar|sky|auto)
 *
 * src=sse      → 直接用 FlightListSearchSSE（最準確）
 * src=calendar → 用 GetLowPriceInCalender（日曆最低價，可能有落差）
 * src=sky      → Skyscanner RapidAPI
 * src=auto     → 依序嘗試 sse → calendar → sky
 */
app.get('/api/price', async (req, res) => {
  const { from, to, date, adults = '1', src = 'auto' } = req.query;
  if (!from || !to || !date) {
    return res.status(400).json({ error: '缺少必要參數: from, to, date' });
  }

  const adultNum = parseInt(adults, 10);
  console.log(`[/api/price] ${from}→${to} ${date} adults=${adultNum} src=${src}`);

  try {
    let result = null;

    // 主要：FlightListSearchSSE（即時庫存，與 Trip.com 網站一致）
    if (src === 'sse' || src === 'auto') {
      result = await fetchTripFlightList(from, to, date, adultNum);
    }

    // 備援：GetLowPriceInCalender（日曆最低價，可能低於實際庫存價）
    if (!result && (src === 'calendar' || src === 'auto')) {
      result = await fetchTripCalendar(from, to, date, adultNum);
    }

    // 最後備援：Skyscanner
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
 * GET /api/flights
 * 完整航班列表（來自 FlightListSearchSSE）
 * Query: from, to, date (YYYY-MM-DD), adults (預設1)
 */
app.get('/api/flights', async (req, res) => {
  const { from, to, date, adults = '1' } = req.query;
  if (!from || !to || !date) {
    return res.status(400).json({ error: '缺少必要參數: from, to, date' });
  }

  const adultNum = parseInt(adults, 10);
  console.log(`[/api/flights] ${from}→${to} ${date} adults=${adultNum}`);

  try {
    const result = await fetchTripFlightList(from, to, date, adultNum);
    if (!result) return res.json({ flights: [], currency: 'TWD', source: 'none' });

    return res.json({
      cheapestPrice: result.price,
      flights:       result.allFlights,
      currency:      'TWD',
      source:        result.source,
    });
  } catch (err) {
    console.error('[/api/flights] 例外:', err);
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
  console.log(`✈  FlightGo backend v3 啟動於 port ${PORT}`);
  console.log(`   主端點: FlightListSearchSSE（真實庫存）`);
  console.log(`   備援: GetLowPriceInCalender + Skyscanner`);
  console.log(`   RapidAPI: ${RAPIDAPI_KEY ? '已設定' : '⚠ 未設定'}`);
  ensureTripSession().catch(() => {});
});
