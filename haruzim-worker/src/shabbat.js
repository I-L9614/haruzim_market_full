const HEB_CAL_URL = 'https://www.hebcal.com/shabbat?cfg=json&geonameid=281184&m=50';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedWindow = null;
let cacheExpiresAt = 0;
let usedFallback = false;

function getIsraelTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  return { weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function getIsraelDateParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((result, part) => { result[part.type] = Number(part.value); return result; }, {});
}

function israelLocalDateToUtc(year, month, day, hour, minute) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(guess)).reduce((result, part) => { result[part.type] = Number(part.value); return result; }, {});
    const actualAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += targetAsUtc - actualAsUtc;
  }
  return new Date(guess);
}

function fallbackWindow(now = new Date()) {
  const { weekday } = getIsraelTime(now);
  const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
  const offsetToFriday = weekday === 'Fri' ? 0 : weekday === 'Sat' ? -1 : (5 - weekdayNumber + 7) % 7;
  const parts = getIsraelDateParts(now);
  const friday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetToFriday));
  const start = israelLocalDateToUtc(friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate(), 16, 0);
  const saturday = new Date(Date.UTC(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate() + 1));
  const end = israelLocalDateToUtc(saturday.getUTCFullYear(), saturday.getUTCMonth() + 1, saturday.getUTCDate(), 20, 30);
  return { start, end };
}

async function fetchShabbatWindow() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    // Without an explicit date Hebcal anchors to the most recent Shabbat
    // (observed 2026-11-04: no-date call returned Oct 30-31). Pass today's
    // Israel date so the window is always the current/upcoming one.
    const today = getIsraelDateParts(new Date());
    const url = `${HEB_CAL_URL}&gy=${today.year}&gm=${today.month}&gd=${today.day}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Hebcal responded with ${response.status}`);
    const data = await response.json();
    const candleLighting = data.items?.find((item) => item.category === 'candles')?.date;
    const havdalah = data.items?.find((item) => item.category === 'havdalah')?.date;
    const start = candleLighting ? new Date(candleLighting) : null;
    const end = havdalah ? new Date(havdalah) : null;
    if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw new Error('Hebcal response did not contain valid candle-lighting and havdalah times');
    }
    return { start, end };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getShabbatStatus(date = new Date()) {
  const now = date.getTime();
  if (!cachedWindow || Date.now() >= cacheExpiresAt) {
    try {
      cachedWindow = await fetchShabbatWindow();
      const refreshedAt = Date.now();
      const nextBoundary = cachedWindow.start.getTime() > refreshedAt
        ? cachedWindow.start.getTime()
        : cachedWindow.end.getTime() > refreshedAt ? cachedWindow.end.getTime() : null;
      const boundaryRefreshAt = nextBoundary ? Math.max(refreshedAt + 5000, nextBoundary - 60 * 1000) : refreshedAt + CACHE_TTL_MS;
      cacheExpiresAt = Math.min(refreshedAt + CACHE_TTL_MS, boundaryRefreshAt);
      usedFallback = false;
    } catch (error) {
      cachedWindow = fallbackWindow(date);
      cacheExpiresAt = Date.now() + FAILURE_CACHE_TTL_MS;
      usedFallback = true;
      console.warn('Hebcal check failed; using Israel-local fallback times', error.name || 'HEBCAL_ERROR');
    }
  }
  return {
    isShabbat: now >= cachedWindow.start.getTime() && now <= cachedWindow.end.getTime(),
    source: usedFallback ? 'fallback' : 'hebcal',
    startsAt: cachedWindow.start.toISOString(),
    endsAt: cachedWindow.end.toISOString()
  };
}
