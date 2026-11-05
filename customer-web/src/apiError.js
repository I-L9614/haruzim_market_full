// Central translation of API and network failures into clear, customer-friendly Hebrew.
// The server sends { error: CODE, message: Hebrew } - always prefer the Hebrew message.
// Customers must never see raw error codes or browser English ("Failed to fetch").

const NETWORK_ERROR = 'אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.';
const SERVER_ERROR = 'משהו השתבש אצלנו. נסו שוב בעוד כמה רגעים.';
const RATE_LIMIT_ERROR = 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.';

// Fallback wording for known server error codes, if a response ever arrives
// without its Hebrew message. Mirrors the server wording.
const CODE_MESSAGES = {
  INVALID_CREDENTIALS: 'האימייל או הסיסמה אינם נכונים.',
  INVALID_REGISTRATION: 'יש להזין שם, טלפון תקין, אימייל תקין וסיסמה באורך 12 תווים לפחות.',
  EMAIL_IN_USE: 'כבר קיים חשבון עם כתובת האימייל הזו.',
  PHONE_IN_USE: 'מספר הטלפון כבר משויך לחשבון קיים.',
  AUTH_REQUIRED: 'יש להתחבר לחשבון לקוח.',
  INVALID_TOKEN: 'החיבור לחשבון פג. התחברו מחדש.',
  ORDER_NOT_FOUND: 'לא נמצאה הזמנה התואמת לפרטים.',
  INVALID_CHECKOUT: 'יש למלא שם, טלפון תקין, כתובת למשלוח ולפחות מוצר אחד.',
  INVALID_ITEMS: 'פרטי המוצרים בעגלה אינם תקינים.',
  OUT_OF_STOCK: 'חלק מהמוצרים אינם זמינים עוד במלאי.',
  GOOGLE_LOGIN_NOT_CONFIGURED: 'התחברות Google עדיין לא הוגדרה באתר.',
  INVALID_GOOGLE_CREDENTIAL: 'לא הצלחנו לאמת את חשבון Google.'
};

const looksLikeErrorCode = (text) => typeof text === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(text.trim());

// Safe JSON parse - never throws, returns null for non-JSON bodies (e.g. proxy error pages).
export async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Maps a failed response (+ its parsed body) to a friendly Hebrew message.
export function apiErrorMessage(response, data, fallback) {
  if (data) {
    if (typeof data.message === 'string' && data.message.trim() && !looksLikeErrorCode(data.message)) return data.message;
    if (typeof data.error === 'string' && data.error.trim()) {
      if (!looksLikeErrorCode(data.error)) return data.error;
      if (CODE_MESSAGES[data.error]) return CODE_MESSAGES[data.error];
    }
  }
  const status = response?.status || 0;
  if (status === 429) return RATE_LIMIT_ERROR;
  if (status === 401 || status === 403) return 'החיבור לחשבון פג. התחברו מחדש.';
  if (status === 404) return 'הפריט המבוקש לא נמצא.';
  if (status >= 500) return SERVER_ERROR;
  return fallback || SERVER_ERROR;
}

// fetch that throws a Hebrew message on network failure instead of browser English.
export async function apiFetch(...args) {
  try {
    return await fetch(...args);
  } catch {
    throw new Error(NETWORK_ERROR);
  }
}
