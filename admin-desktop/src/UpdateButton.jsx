import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

// In-app update button in the top bar. The desktop main process owns the
// state machine (electron/updater.js): a newer release only marks a dot on
// this button; downloading and installing each need an explicit approval
// here. Hidden entirely outside the packaged desktop app (web/dev builds get
// status 'disabled').
const STATUS_LABELS = {
  idle: 'עדכון',
  checking: 'בודק…',
  uptodate: 'עדכון',
  available: 'עדכון זמין',
  downloading: 'מוריד',
  downloaded: 'התקנת עדכון',
  error: 'ניסיון חוזר'
};

export default function UpdateButton() {
  const bridge = window.haruzimDesktop;
  const [state, setState] = useState(null);
  const [manualCheck, setManualCheck] = useState(false);
  const [dialog, setDialog] = useState(null); // 'download' | 'install' | null
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!bridge?.getUpdateState) return undefined;
    const off = bridge.onUpdateStatus?.((next) => {
      setState((previous) => {
        if (next?.status === 'downloaded' && previous?.status !== 'downloaded') setDialog('install');
        if (manualCheck && next?.status === 'uptodate') { setNotice('האפליקציה מעודכנת לגרסה האחרונה'); setManualCheck(false); }
        if (manualCheck && next?.status === 'error') { setNotice('בדיקת העדכון נכשלה. נסו שוב מאוחר יותר.'); setManualCheck(false); }
        return next;
      });
    });
    bridge.getUpdateState().then((current) => { if (current) setState(current); });
    return () => { if (typeof off === 'function') off(); };
    // manualCheck is read inside the status listener; including it would
    // re-subscribe on every manual check, so it is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!bridge?.getUpdateState || !state || state.status === 'disabled') return null;

  const hasUpdate = state.status === 'available' || state.status === 'downloaded';
  const busy = state.status === 'checking' || state.status === 'downloading';
  const label = state.status === 'downloading'
    ? `מוריד ${state.percent ?? 0}%`
    : (STATUS_LABELS[state.status] || 'עדכון');

  const onClick = async () => {
    if (state.status === 'available') { setDialog('download'); return; }
    if (state.status === 'downloaded') { setDialog('install'); return; }
    setManualCheck(true);
    try { await bridge.checkForUpdates(); }
    catch { setNotice('בדיקת העדכון נכשלה. נסו שוב מאוחר יותר.'); setManualCheck(false); }
  };

  const approveDownload = async () => {
    setDialog(null);
    try { await bridge.downloadUpdate(); }
    catch { setNotice('הורדת העדכון נכשלה. נסו שוב מאוחר יותר.'); }
  };

  const approveInstall = async () => {
    setDialog(null);
    try {
      const result = await bridge.installUpdate();
      // The main process enforces the write guard: a refusal means a save
      // started after this dialog opened.
      if (result && result.installed === false) {
        setNotice(result.reason === 'pending-writes'
          ? 'יש שמירה שעדיין מתבצעת — ההתקנה תתאפשר כשתסתיים'
          : 'התקנת העדכון נכשלה. נסו שוב.');
      }
    } catch { setNotice('התקנת העדכון נכשלה. נסו שוב.'); }
  };

  return (
    <div className="update-slot">
      <button
        type="button"
        id="updateButton"
        className={`update-button${hasUpdate ? ' has-update' : ''}`}
        disabled={busy}
        onClick={onClick}
        title="בדיקת עדכונים לאפליקציה"
      >
        <RefreshCw size={14} className={busy ? 'update-spin' : ''} />
        <span>{label}</span>
        {hasUpdate && <span className="update-dot" aria-label="יש עדכון חדש" />}
      </button>
      {notice && <div className="update-notice" role="status">{notice}</div>}

      {dialog === 'download' && (
        <div className="update-modal-backdrop" role="dialog" aria-modal="true" aria-label="עדכון זמין">
          <div className="update-modal">
            <h3>עדכון זמין{state.version ? ` - גרסה ${state.version}` : ''}</h3>
            <p>נמצאה גרסה חדשה של תוכנת הניהול. לאחר האישור ההורדה מתבצעת ברקע ואפשר להמשיך לעבוד כרגיל. רק בסיום ההורדה תתבקשו לאשר את ההתקנה עצמה.</p>
            <div className="update-modal-actions">
              <button type="button" className="primary-btn" onClick={approveDownload}>הורדת העדכון</button>
              <button type="button" className="update-secondary" onClick={() => setDialog(null)}>מאוחר יותר</button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'install' && (
        <div className="update-modal-backdrop" role="dialog" aria-modal="true" aria-label="העדכון מוכן להתקנה">
          <div className="update-modal">
            <h3>העדכון מוכן להתקנה{state.version ? ` - גרסה ${state.version}` : ''}</h3>
            <p>בלחיצה על "עדכון עכשיו" האפליקציה תיסגר, תתקין את הגרסה החדשה ותיפתח מחדש. הנתונים, ההגדרות וההתחברות נשמרים, אבל טופס פתוח שלא נשמר יאבד כמו בכל סגירה של האפליקציה - כדאי לשמור לפני ההתקנה. "מאוחר יותר" משאיר את הכול כמות שהוא, וכפתור העדכון ימשיך להציע את ההתקנה.</p>
            <div className="update-modal-actions">
              <button type="button" className="primary-btn" onClick={approveInstall}>עדכון עכשיו</button>
              <button type="button" className="update-secondary" onClick={() => setDialog(null)}>מאוחר יותר</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
