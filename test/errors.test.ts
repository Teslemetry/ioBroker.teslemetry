import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Teslemetry } from '@teslemetry/api';
import { describeError, withHttpErrors } from '../lib/errors.js';

// Runs the SDK's real request path against a stubbed fetch and returns the text
// the adapter would log for the rejection.
async function describeStartupFailure(t: TestContext, fetch: () => Promise<Response>): Promise<string> {
	t.mock.method(globalThis, 'fetch', fetch);
	const teslemetry = withHttpErrors(new Teslemetry('fake-token', { region: 'na' }));
	try {
		await teslemetry.createProducts();
	} catch (error) {
		return describeError(error);
	}
	throw new Error('createProducts() did not reject');
}

const json = (status: number, body: unknown) => async () =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('a 401 is named as a rejected access token with the API\'s error_description (regression: logged "undefined")', async (t) => {
	const text = await describeStartupFailure(
		t,
		json(401, { response: null, error: 'invalid_token', error_description: 'Invalid access token' })
	);
	assert.equal(text, 'Access token rejected (HTTP 401): Invalid access token');
});

test('a 402 is named as a subscription or credits problem, falling back to `error` without a description', async (t) => {
	const text = await describeStartupFailure(t, json(402, { response: null, error: 'subscription_required' }));
	assert.equal(text, 'Subscription or credits required (HTTP 402): subscription_required');
});

test('a plain-text 500 is described by its HTTP status', async (t) => {
	const text = await describeStartupFailure(t, async () => new Response('upstream exploded', { status: 500 }));
	assert.equal(text, 'Internal Server Error (HTTP 500)');
});

test('a network error keeps its message and adds the underlying cause', async (t) => {
	const text = await describeStartupFailure(t, async () => {
		throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') });
	});
	assert.equal(text, 'fetch failed: connect ECONNREFUSED 127.0.0.1:443');
});

test('describeError never yields "undefined" for the shapes the SDK rejects with', () => {
	assert.equal(describeError({ response: null, error: 'x', error_description: 'vehicle unavailable' }), 'vehicle unavailable');
	assert.equal(describeError({ response: null, error: 'not_found' }), 'not_found');
	assert.equal(describeError('Bad Gateway'), 'Bad Gateway');
	assert.equal(describeError(new Error('DB closed')), 'DB closed');
	assert.equal(describeError({}), 'Unknown error');
	assert.equal(describeError(undefined), 'Unknown error');
});
