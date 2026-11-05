// Central translation of API and network failures into clear, actionable Hebrew.
// Mirrors the customer-site mapper (customer-web/src/apiError.js).
// The server sends { error: CODE, message: Hebrew } - always prefer the Hebrew message.
// Staff must never see raw error codes or browser English ("Failed to fetch").

const NETWORK_ERROR = 'אין חיבור לשרת כרגע. בדקו שהמחשב מחובר לאינטרנט ונסו שוב.';
const SERVER_ERROR = 'משהו השתבש בשרת. נסו שוב בעוד כמה רגעים.';
const RATE_LIMIT_ERROR = 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.';
const SESSION_EXPIRED = 'פג תוקף ההתחברות. יש להתחבר מחדש.';

// Fallback wording for known server error codes, if a response ever arrives
// without its Hebrew message. Mirrors the server wording.
const CODE_MESSAGES = {
  INVALID_CREDENTIALS: 'אימייל או סיסמה שגויים.',
  AUTH_REQUIRED: SESSION_EXPIRED,
  INVALID_TOKEN: SESSION_EXPIRED,
  UNAUTHORIZED: SESSION_EXPIRED,
  ACCOUNT_DISABLED: 'החשבון אינו פעיל. יש לפנות למנהל המערכת.',
  FORBIDDEN: 'אין הרשאה לבצע את הפעולה הזו.',
  OWNER_REQUIRED: 'רק מנהל ראשי יכול לנהל חשבונות מנהלים.',
  INVALID_MANAGER: 'יש להזין שם תקין, כתובת אימייל וסיסמה באורך 12 תווים לפחות.',
  MANAGER_NOT_FOUND: 'המנהל לא נמצא או שכבר הוסר.',
  EMAIL_IN_USE: 'כבר קיים חשבון עם כתובת האימייל הזו.',
  INVALID_PRODUCT: 'פרטי המוצר אינם תקינים. יש לבדוק שם, קטגוריה ומחיר.',
  INVALID_PRODUCT_ID: 'מזהה המוצר אינו תקין.',
  PRODUCT_NOT_FOUND: 'המוצר לא נמצא. ייתכן שהוסר מהחנות.',
  INVALID_CATEGORY: 'יש לבחור קטגוריה תקינה.',
  CATEGORY_EXISTS: 'כבר קיימת קטגוריה בשם הזה.',
  INVALID_ORDER_STATUS: 'סטטוס ההזמנה אינו תקין.',
  ORDER_TRANSITION_NOT_ALLOWED: 'לא ניתן לשנות את סטטוס ההזמנה במצב הנוכחי.',
  ORDER_NOT_FOUND: 'ההזמנה לא נמצאה.',
  INVALID_CURSOR: 'לא ניתן לטעון את ההיסטוריה כרגע. רעננו את הדף.',
  OUT_OF_STOCK: 'חלק מהמוצרים אזלו מהמלאי.'
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
  if (status === 401 || status === 403) return SESSION_EXPIRED;
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
