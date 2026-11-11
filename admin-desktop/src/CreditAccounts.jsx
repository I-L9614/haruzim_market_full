import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiErrorMessage, parseJson } from './apiError';
import { beginUpdateSave } from './updateGuard';
const money = c => `${(Number(c || 0) / 100).toFixed(2)}₪`;
export function CreditDecision({ order, onCancel, onSave, busy }) {
  const [mode, setMode] = useState('total'), [amount, setAmount] = useState(''), [reason, setReason] = useState('');
  const valid = mode !== 'custom' || (/^-?\d+(\.\d{1,2})?$/.test(amount) && reason.trim().length >= 2);
  return <div className="modal-backdrop"><section className="modal-card credit-dialog" role="dialog" aria-modal="true" aria-labelledby="credit-decision-title">
    <h2 id="credit-decision-title">מסירה ורישום חוב בהקפה</h2>
    <p>{order.credit?.name} · הזמנה {String(order._id).slice(-8)}</p>
    <p>בחרו את השינוי בחוב. המסירה והחלטת החוב יישמרו יחד, פעם אחת בלבד.</p>
    <label>מה להוסיף לחוב?<select autoFocus value={mode} onChange={e => setMode(e.target.value)}><option value="total">סכום ההזמנה: {Number(order.total).toFixed(2)}₪</option><option value="custom">סכום אחר, כולל סכום שלילי</option><option value="skip">לא להוסיף לחוב</option></select></label>
    {mode === 'custom' && <><label>שינוי בחוב (₪)<input type="number" step="0.01" min="-1000000" max="1000000" value={amount} onChange={e => setAmount(e.target.value)} /></label><p>סכום חיובי מגדיל חוב. סכום שלילי מפחית חוב קודם. יתרה שלילית היא זכות ללקוח.</p><label>סיבת השינוי<input maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder="למשל: שולם חלק מהסכום במסירה" /></label></>}
    <div className="credit-actions"><button type="button" disabled={busy || !valid} onClick={() => onSave({ mode, ...(mode === 'custom' ? { amount } : {}), reason })}>{busy ? 'שומר…' : 'אישור מסירה ורישום'}</button><button type="button" disabled={busy} onClick={onCancel}>חזרה ללא שינוי</button></div>
  </section></div>;
}
export default function CreditAccounts({ apiBase, token, disabled, revision }) {
  const [accounts, setAccounts] = useState([]), [form, setForm] = useState({ name: '', password: '' }), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState(null), [history, setHistory] = useState([]), [nextBefore, setNextBefore] = useState(null), [amount, setAmount] = useState(''), [reason, setReason] = useState(''), [newCode, setNewCode] = useState(''), [search, setSearch] = useState('');
  const request = useCallback(async (path, method = 'GET', body) => {
    const res = await apiFetch(`${apiBase}/admin/credit-accounts${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await parseJson(res); if (!res.ok) throw new Error(apiErrorMessage(res, data, 'פעולת ההקפה נכשלה.')); return data;
  }, [apiBase, token]);
  const load = useCallback(async () => { try { const data = await request(''); setAccounts(data.accounts || []); } catch (e) { setError(e.message); } }, [request]);
  useEffect(() => { load(); }, [load, revision]);
  const select = async a => { setError(''); try { const data = await request(`/${a._id}/history`); setSelected(data.account); setAmount((data.account.balanceCents / 100).toFixed(2)); setReason(''); setNewCode(''); setHistory(data.entries || []); setNextBefore(data.nextBefore); } catch(e) {setError(e.message);} };
  const run = async action => { setBusy(true); setError(''); setNotice(''); try { await action(); await load(); } catch(e) { setError(e.message); } finally {setBusy(false);} };
  const adjust = mode => { const markSaved = beginUpdateSave('.credit-detail'); return run(async () => {
    if (!reason.trim()) throw new Error('יש לציין סיבת שינוי.');
    const target = mode === 'reset' ? 0 : Number(amount);
    if (!Number.isFinite(target) || (mode !== 'reset' && !/^-?\d+(\.\d{1,2})?$/.test(amount))) throw new Error('יש להזין סכום תקין.');
    if (!window.confirm(`לשנות את היתרה של ${selected.name} מ-${money(selected.balanceCents)} ל-${target.toFixed(2)}₪? שינוי זה אינו מחייב כרטיס ואינו שולח תשלום.`)) return;
    const data = await request(`/${selected._id}/balance`, 'PATCH', { mode, amount, reason, expectedVersion: selected.version, requestId: crypto.randomUUID() });
    await select(data.account); markSaved(); setNotice('היתרה עודכנה ונשמרה בהיסטוריה.');
  }); };
  return <section className="panel credit-panel" id="credit-accounts">
    <div className="panel-header"><h2>לקוחות בהקפה</h2><button type="button" disabled={busy} onClick={load}>רענון יתרות</button></div>
    <p>הקפה נפרדת מחשבון ההתחברות לאתר. המנהל מוסר ללקוח את השם והקוד. הקוד נשמר בצורה מאובטחת ולא מוצג שוב.</p>
    {error && <p className="error-banner" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <form className="credit-create" onSubmit={e => {e.preventDefault(); const markSaved = beginUpdateSave(e.currentTarget); run(async () => {await request('', 'POST', form); markSaved(); setForm({ name: '', password: '' }); setNotice('לקוח ההקפה נוצר עם יתרה אפס. מסרו לו את השם והקוד בערוץ פרטי.');});}}>
      <label>שם לקוח להקפה<input required minLength={2} maxLength={80} value={form.name} onChange={e => setForm({...form, name:e.target.value})} autoComplete="off" /></label>
      <label>קוד ללקוח (לפחות 8 תווים)<input required type="password" minLength={8} maxLength={72} value={form.password} onChange={e => setForm({...form, password:e.target.value})} autoComplete="new-password" /></label>
      <button disabled={disabled || busy} type="submit">יצירת לקוח הקפה</button>
    </form>
    <label>חיפוש לקוח<input value={search} onChange={e => setSearch(e.target.value)} /></label>
    <div className="credit-list">{accounts.filter(a => a.name.includes(search)).map(a => <button className="credit-account" key={a._id} type="button" onClick={() => select(a)}><strong>{a.name}</strong><span>{a.balanceCents < 0 ? 'זכות' : 'חוב'}: {money(Math.abs(a.balanceCents))}</span><small>{a.active ? 'פעיל' : 'חסום להזמנות חדשות'}</small></button>)}{!accounts.length && <p>אין עדיין לקוחות בהקפה.</p>}</div>
    {selected && <div className="credit-detail"><h3>{selected.name}</h3><p>יתרה נוכחית: {money(selected.balanceCents)} · {selected.balanceCents < 0 ? 'זכות ללקוח' : 'חוב לחנות'}</p>
      <label>יתרה חדשה (₪), לא סכום להוספה<input type="number" step="0.01" min="-1000000" max="1000000" value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label>סיבת השינוי / פרטי תשלום<input maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder="למשל: התקבל תשלום במזומן" /></label>
      <div className="credit-actions"><button type="button" disabled={disabled || busy || reason.trim().length < 2} onClick={() => adjust('set')}>שמירת יתרה חדשה</button><button type="button" disabled={disabled || busy || reason.trim().length < 2} onClick={() => adjust('reset')}>איפוס לאחר תשלום</button><button type="button" disabled={disabled || busy} onClick={() => run(async () => { if (!window.confirm(`${selected.active ? 'לחסום הזמנות הקפה חדשות' : 'להפעיל הקפה'} עבור ${selected.name}? היתרה וההיסטוריה לא יימחקו.`)) return; const d = await request(`/${selected._id}/access`, 'PATCH', { active: !selected.active, expectedVersion: selected.version }); await select(d.account); })}>{selected.active ? 'חסימת הקפה' : 'הפעלת הקפה'}</button></div>
      <form className="credit-create" onSubmit={e => {e.preventDefault(); const markSaved = beginUpdateSave(e.currentTarget); run(async () => {if (!window.confirm('להחליף את הקוד? הקוד הישן לא יעבוד עוד.')) return; const d = await request(`/${selected._id}/access`, 'PATCH', {password: newCode, expectedVersion: selected.version}); await select(d.account); markSaved(); setNewCode(''); setNotice('הקוד הוחלף. מסרו את הקוד החדש ללקוח באופן פרטי.');});}}><label>קוד חדש<input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={newCode} onChange={e => setNewCode(e.target.value)} /></label><button disabled={disabled || busy} type="submit">החלפת קוד</button></form>
      <h3>היסטוריית יתרה</h3><div className="credit-history">{history.map(e => <article key={e._id}><strong>{new Date(e.createdAt).toLocaleString('he-IL')}</strong><span>שינוי: {money(e.deltaCents)} · יתרה: {money(e.afterCents)}</span><span>{e.reason || ({delivery:'מסירת הזמנה',reset:'איפוס לאחר תשלום',set:'שינוי יתרה'}[e.kind])}</span>{e.order && <small>הזמנה: {String(e.order).slice(-8)}</small>}</article>)}</div>
      {nextBefore && <button type="button" onClick={() => run(async () => { const d = await request(`/${selected._id}/history?before=${encodeURIComponent(nextBefore)}`); setHistory(v => [...v, ...d.entries]); setNextBefore(d.nextBefore); })}>היסטוריה מוקדמת יותר</button>}
    </div>}
  </section>;
}
