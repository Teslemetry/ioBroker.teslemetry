import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectedAfter } from '../lib/connection.js';

test('connectedAfter is false when every device request failed (regression: start-up reported connected)', () => {
	assert.equal(connectedAfter([false, false]), false);
});

test('connectedAfter is true when any request succeeded or there were none', () => {
	assert.equal(connectedAfter([false, true]), true);
	assert.equal(connectedAfter([]), true);
});
