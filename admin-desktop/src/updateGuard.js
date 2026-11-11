// Guards the update install against losing work. The install closes the app
// by itself, so before it runs there must be an explicit decision when real
// state is at risk (same rules as KinderGuard):
//
// - Pending writes (any in-flight mutating API request - product/category/
//   manager saves, image uploads) BLOCK the install outright. Latency is
//   never assumed; a write counts until it settles. No discard is offered.
// - Dirty forms (a form whose fields the user edited) require an explicit
//   discard choice, allowed only once no write is pending.
//
// createUpdateGuard is DOM-free so it is unit-testable; the bottom of this
// module wires fetch and form input events into a singleton and reports
// every change to the Electron main process, which enforces the same rules
// on the update-install IPC so no caller can bypass the renderer dialogs.

export const createUpdateGuard = () => {
  let dirtyForms = 0;
  let pendingWrites = 0;
  let pendingUploads = 0;
  const listeners = new Set();

  const state = () => ({
    dirtyForms,
    pendingWrites,
    pendingUploads,
    blocked: pendingWrites > 0,
    needsDecision: dirtyForms > 0 || pendingWrites > 0,
  });

  const changed = () => listeners.forEach((fn) => fn(state()));
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  // One call per form that received its first real edit; formClosed releases
  // exactly that one mark, so counts never go negative. Programmatic prefill
  // does not mark dirty - only user input events do.
  const formBecameDirty = () => { dirtyForms += 1; changed(); };
  const formClosed = (wasDirty) => { if (wasDirty) { dirtyForms = Math.max(0, dirtyForms - 1); changed(); } };

  // Every mutating API request counts from start until it settles - success,
  // error or network failure - however long it takes.
  const mutationStarted = ({ upload = false } = {}) => { pendingWrites += 1; if (upload) pendingUploads += 1; changed(); };
  const mutationFinished = ({ upload = false } = {}) => {
    pendingWrites = Math.max(0, pendingWrites - 1);
    if (upload) pendingUploads = Math.max(0, pendingUploads - 1);
    changed();
  };

  // Hebrew description of what is at risk, for the decision dialogs.
  const describe = () => {
    const parts = [];
    if (dirtyForms > 0) parts.push(dirtyForms === 1 ? 'טופס אחד עם שינויים שלא נשמרו' : `${dirtyForms} טפסים עם שינויים שלא נשמרו`);
    if (pendingUploads > 0) parts.push(pendingUploads === 1 ? 'העלאת קובץ שעדיין מתבצעת' : `${pendingUploads} העלאות שעדיין מתבצעות`);
    const otherWrites = pendingWrites - pendingUploads;
    if (otherWrites > 0) parts.push(otherWrites === 1 ? 'שמירה שעדיין מתבצעת' : `${otherWrites} שמירות שעדיין מתבצעות`);
    return parts.join(' וגם ');
  };

  return { state, onChange, formBecameDirty, formClosed, mutationStarted, mutationFinished, describe };
};

// ---------- Browser wiring (renderer only) ----------

export const updateGuard = createUpdateGuard();

const bridge = typeof window !== 'undefined' ? window.haruzimDesktop : null;
// Exposed for the packaged smoke tests (assert guard state directly).
if (typeof window !== 'undefined') window.__updateGuard = updateGuard;

if (typeof window !== 'undefined') {
  const report = (s) => { try { bridge?.reportUpdateGuard?.(s); } catch { /* the guard must never break the app */ } };
  updateGuard.onChange(report);

  // Forms whose unsaved edits are real data at risk. The login card and the
  // update dialogs themselves never count.
  const RISK_FORM = 'form:not(.login-card), .featured-select-form, .credit-dialog, .credit-detail';
  const inUpdateDialog = (node) => Boolean(node.closest?.('.update-modal-backdrop'));

  const dirtyNodes = new Set();
  const revisions = new WeakMap();
  const markDirty = (form) => {
    if (!form) return;
    revisions.set(form, (revisions.get(form) || 0) + 1);
    if (dirtyNodes.has(form)) return;
    dirtyNodes.add(form);
    updateGuard.formBecameDirty();
  };
  const release = (form) => {
    if (!dirtyNodes.delete(form)) return;
    updateGuard.formClosed(true);
  };

  // A submit is NOT a save: validation, permission, network or server errors
  // must keep the dirty mark. Only an explicit success callback or unmount
  // releases it. Revision checks preserve edits made while a save is pending.
  window.__beginUpdateSave = (selector) => {
    const node = typeof selector === 'string' ? document.querySelector(selector) : selector;
    const revision = revisions.get(node) || 0;
    return () => { if (node && (revisions.get(node) || 0) === revision) release(node); };
  };
  document.addEventListener('input', onEdit, true);
  document.addEventListener('change', onEdit, true);
  function onEdit(event) {
    const form = event.target?.closest?.(RISK_FORM);
    if (form && !inUpdateDialog(form)) markDirty(form);
  }
  // Image removal uses buttons rather than input/change events.
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.product-image-upload-field button');
    if (button) markDirty(button.closest(RISK_FORM));
  }, true);

  // A form that unmounts (modal closed, view switched) no longer holds data
  // the install could lose - release its mark.
  const sweep = () => { dirtyNodes.forEach((form) => { if (!form.isConnected) release(form); }); };
  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });

  // Every mutating API request counts from start until it settles. Read-only
  // GET/HEAD traffic is not tracked. Multipart bodies are uploads (images).
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') return originalFetch(input, init);
      const upload = typeof FormData !== 'undefined' && init?.body instanceof FormData;
      updateGuard.mutationStarted({ upload });
      try {
        return await originalFetch(input, init);
      } finally {
        updateGuard.mutationFinished({ upload });
      }
    };
  }

  report(updateGuard.state());
}

// Call before a save and invoke the returned callback ONLY after confirmed
// success. No-op outside the renderer; never sends field values to main.
export const beginUpdateSave = (selector) => typeof window !== 'undefined'
  ? (window.__beginUpdateSave?.(selector) || (() => {})) : (() => {});
