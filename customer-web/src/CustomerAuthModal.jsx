import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, Mail, UserRound, X } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3000/api' : '');
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

export default function CustomerAuthModal({ onClose, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const googleButton = useRef(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !googleButton.current) return undefined;
    let isMounted = true;
    let script = document.querySelector('script[data-google-identity]');
    const renderButton = () => {
      if (!isMounted || !googleButton.current || !window.google?.accounts?.id) return;
      googleButton.current.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async ({ credential }) => {
          setBusy(true);
          setError('');
          try {
            const response = await fetch(`${API_BASE}/auth/customer/google`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן להתחבר באמצעות Google.');
            onAuthenticated(data);
          } catch (authError) {
            setError(authError.message || 'התחברות Google נכשלה.');
          } finally {
            setBusy(false);
          }
        }
      });
      window.google.accounts.id.renderButton(googleButton.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 300, locale: 'he' });
    };

    if (window.google?.accounts?.id) {
      renderButton();
    } else {
      if (!script) {
        script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.googleIdentity = 'true';
        document.head.appendChild(script);
      }
      script.addEventListener('load', renderButton);
    }
    return () => {
      isMounted = false;
      script?.removeEventListener('load', renderButton);
    };
  }, [onAuthenticated]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!API_BASE) {
      setError('כתובת שרת החנות לא הוגדרה. נסו שוב מאוחר יותר.');
      return;
    }
    setBusy(true);
    try {
      const path = mode === 'register' ? 'register' : 'login';
      const response = await fetch(`${API_BASE}/auth/customer/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || 'לא ניתן להתחבר כרגע.');
      onAuthenticated(data);
    } catch (authError) {
      setError(authError.message || 'לא ניתן להתחבר כרגע.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" dir="rtl">
        <button className="auth-close" type="button" aria-label="סגירה" onClick={onClose}><X size={19} /></button>
        <div className="auth-icon"><UserRound size={22} /></div>
        <p className="eyebrow">החשבון שלי</p>
        <h2 id="auth-title">{mode === 'login' ? 'כיף שחזרת' : 'יצירת חשבון חדש'}</h2>
        <p className="auth-subtitle">אפשר להמשיך כאורח, או להתחבר כדי לשמור את ההזמנות ולבצע הזמנה חוזרת.</p>

        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>התחברות</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>הרשמה</button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === 'register' && <label><span><UserRound size={15} /> שם מלא</span><input required minLength="2" maxLength="120" autoComplete="name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} /></label>}
          <label><span><Mail size={15} /> אימייל</span><input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))} /></label>
          <label><span><LockKeyhole size={15} /> סיסמה</span><input required type="password" minLength={mode === 'register' ? 12 : 1} maxLength="128" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={form.password} onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))} />{mode === 'register' && <small>לפחות 12 תווים</small>}</label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="primary-btn full" type="submit" disabled={busy}>{busy ? 'מתחברים…' : mode === 'login' ? 'התחברות עם אימייל' : 'יצירת חשבון'}</button>
        </form>

        <div className="auth-divider"><span>או</span></div>
        {GOOGLE_CLIENT_ID ? <div className="google-auth-button" ref={googleButton} /> : <p className="google-config-note">התחברות Google תופעל לאחר הגדרת GOOGLE_CLIENT_ID באתר.</p>}
        <button className="guest-continue" type="button" onClick={onClose}>המשך כאורח ללא חשבון</button>
      </section>
    </div>
  );
}
