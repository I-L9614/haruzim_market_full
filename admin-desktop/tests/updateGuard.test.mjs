import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateGuard } from '../src/updateGuard.js';

// The renderer guard core: dirty forms and in-flight writes are counted
// independently, released exactly once, and described in Hebrew for the
// install decision dialogs.

test('forms count dirty from the first edit until they close', () => {
  const guard = createUpdateGuard();
  assert.deepEqual(guard.state(), { dirtyForms: 0, pendingWrites: 0, pendingUploads: 0, blocked: false, needsDecision: false });
  guard.formBecameDirty();
  guard.formBecameDirty();
  assert.equal(guard.state().dirtyForms, 2);
  assert.equal(guard.state().needsDecision, true);
  assert.equal(guard.state().blocked, false, 'dirty forms alone do not hard-block');
  guard.formClosed(true);
  guard.formClosed(true);
  assert.equal(guard.state().dirtyForms, 0);
  assert.equal(guard.state().needsDecision, false);
});

test('closing a clean form releases nothing; counts never go negative', () => {
  const guard = createUpdateGuard();
  guard.formBecameDirty();
  guard.formClosed(false); // a different, clean form closed
  assert.equal(guard.state().dirtyForms, 1);
  guard.formClosed(true);
  guard.formClosed(true); // double release
  assert.equal(guard.state().dirtyForms, 0);
});

test('writes block from start until settle, success or failure alike', () => {
  const guard = createUpdateGuard();
  guard.mutationStarted();
  assert.equal(guard.state().blocked, true);
  guard.mutationStarted({ upload: true });
  assert.equal(guard.state().pendingWrites, 2);
  assert.equal(guard.state().pendingUploads, 1);
  guard.mutationFinished();
  assert.equal(guard.state().blocked, true, 'one write still in flight');
  guard.mutationFinished({ upload: true });
  assert.equal(guard.state().blocked, false);
  guard.mutationFinished(); // over-settle must not go negative
  assert.equal(guard.state().pendingWrites, 0);
});

test('describe names the work at risk in Hebrew', () => {
  const guard = createUpdateGuard();
  guard.formBecameDirty();
  assert.equal(guard.describe(), 'טופס אחד עם שינויים שלא נשמרו');
  guard.formBecameDirty();
  assert.equal(guard.describe(), '2 טפסים עם שינויים שלא נשמרו');
  guard.mutationStarted();
  assert.equal(guard.describe(), '2 טפסים עם שינויים שלא נשמרו וגם שמירה שעדיין מתבצעת');
  guard.mutationStarted({ upload: true });
  assert.equal(guard.describe(), '2 טפסים עם שינויים שלא נשמרו וגם העלאת קובץ שעדיין מתבצעת וגם שמירה שעדיין מתבצעת');
});

test('onChange fires on every transition with the current state', () => {
  const guard = createUpdateGuard();
  const seen = [];
  const off = guard.onChange((s) => seen.push(s));
  guard.formBecameDirty();
  guard.mutationStarted();
  guard.mutationFinished();
  assert.deepEqual(seen.map((s) => [s.dirtyForms, s.pendingWrites]), [[1, 0], [1, 1], [1, 0]]);
  off();
  guard.formClosed(true);
  assert.equal(seen.length, 3, 'unsubscribed listeners stop firing');
});
