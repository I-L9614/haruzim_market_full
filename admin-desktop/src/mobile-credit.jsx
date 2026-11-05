import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CreditAccounts, { CreditDecision } from './CreditAccounts';
import './mobile-credit.css';
const apiBase = 'https://haruzim-api.haruzim-probe.workers.dev/api';
function Widget() {
  const [auth, setAuth] = useState({ token: localStorage.getItem('hmgr_token') || '', disabled: false });
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [decision, setDecision] = useState(null);
  useEffect(() => {
    const update = e => setAuth(e.detail);
    window.addEventListener('manager-credit-auth', update);
    window.addEventListener('manager-credit-refresh', () => setRevision(v => v + 1));
    window.creditDeliveryDecision = order => new Promise(resolve => setDecision({ order, resolve }));
    return () => { window.removeEventListener('manager-credit-auth', update); delete window.creditDeliveryDecision; };
  }, []);
  return <>{auth.token && <button className="credit-route-btn" onClick={() => { const next = !open; setOpen(next); document.querySelectorAll('#ordersView > :not(#creditWidget)').forEach(e => { e.hidden = next; }); }}>{open ? 'חזרה להזמנות' : 'לקוחות בהקפה'}</button>}{auth.token && open && <CreditAccounts apiBase={apiBase} token={auth.token} disabled={auth.disabled} revision={revision} />}{decision && <CreditDecision order={decision.order} onCancel={() => {decision.resolve(null); setDecision(null);}} onSave={value => {decision.resolve(value); setDecision(null);}} />}</>;
}
createRoot(document.getElementById('creditWidget')).render(<Widget />);
