import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatDate, kindOf } from '../lib/format.ts';
import { PIN_MAX, PIN_MIN, SETUP_PIN_MIN, usePin } from '../lib/usePin.ts';

test('formatBytes', () => {
  assert.deepEqual(
    [0, 1023, 1024, 1536, 1048576, 5.5 * 1048576, 1073741824].map(formatBytes),
    ['0 B', '1023 B', '1 KB', '2 KB', '1.0 MB', '5.5 MB', '1.00 GB'],
  );
});

test('kindOf', () => {
  assert.equal(kindOf('photo.JPG', 'image/jpeg'), 'jpg');
  assert.equal(kindOf('archive.tar.gz', ''), 'gz');
  assert.equal(kindOf('.bashrc', 'text/plain'), 'plain');
  assert.equal(kindOf('noext', 'application/pdf'), 'pdf');
  assert.equal(kindOf('trailingdot.', ''), 'file');
});

test('formatDate hides the year only for this year', () => {
  const now = new Date();
  assert.equal(formatDate(new Date(now.getFullYear(), 0, 5).getTime()), '5 Jan');
  assert.equal(formatDate(new Date(2020, 11, 31).getTime()), '31 Dec 2020');
});

test('PIN buffer: ASCII digits out, buffer zeroed, capped at 12', () => {
  assert.deepEqual([PIN_MIN, SETUP_PIN_MIN, PIN_MAX], [4, 6, 12]);
  const p = usePin();
  for (const d of [1, 2, 3, 4, 5, 6]) p.push(d);
  assert.equal(p.size(), 6, 'size() is live; count only updates on the next render');
  for (const d of [7, 8, 9, 0, 1, 2, 3, 4]) p.push(d);
  p.pop();
  assert.equal(p.size(), 11);
  const out = p.take();
  assert.deepEqual([...out], [...'12345678901'].map((c) => c.charCodeAt(0)));
  assert.equal(p.take().length, 0, 'take() cleared the buffer');
});
