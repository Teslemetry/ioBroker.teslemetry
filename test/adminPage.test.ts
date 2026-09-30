import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { testConnection } from '../lib/ConnectionTest.js';
import { filterDevices } from '../lib/DeviceFilter.js';

const packageRoot = path.dirname(__dirname);
const readJson = (file: string) => JSON.parse(readFileSync(path.join(packageRoot, file), 'utf8'));

const products = {
	vehicles: { '5YJ3E1EA7KF000001': { name: 'Lab Model 3' } },
	energySites: { '1234567890': { name: 'Home' } },
};

test('io-package.json enables the message box, without which js-controller never delivers "Test Connection"', () => {
	assert.equal(readJson('io-package.json').common.messagebox, true);
});

test('the "Test Connection" button sends the command the adapter answers', () => {
	const button = readJson('admin/jsonConfig.json').items.testConnection;

	assert.equal(button.type, 'sendTo');
	assert.equal(button.command, 'testConnection');
	assert.deepEqual(JSON.parse(button.jsonData), { accessToken: '${data.accessToken}' });
});

test('testConnection replies with {result: text} naming the vehicles and energy sites it found', async () => {
	const reply = await testConnection({ accessToken: 'token' }, async (token) => {
		assert.equal(token, 'token');
		return products;
	});

	// admin shows `result` when it is a string, and only the word "Ok" otherwise.
	assert.deepEqual(Object.keys(reply), ['result']);
	const { result } = reply as { result: string };
	assert.match(result, /1 vehicle\(s\) and 1 energy site\(s\)/);
	assert.match(result, /Lab Model 3 \(5YJ3E1EA7KF000001\)/);
	assert.match(result, /Home \(1234567890\)/);
});

test('testConnection replies with {error: text} when the API call fails', async () => {
	const reply = await testConnection({ accessToken: 'token' }, async () => {
		throw new Error('fetch failed');
	});

	assert.deepEqual(reply, { error: 'Connection failed: fetch failed' });
});

test('testConnection names the reason when the API rejects the token', async () => {
	const reply = await testConnection({ accessToken: 'bad' }, async () => {
		// What the SDK throws on a 401: the parsed response body.
		throw { response: null, error: 'invalid_token', error_description: 'The access token is invalid' };
	});

	assert.deepEqual(reply, { error: 'Connection failed: The access token is invalid' });
});

test('testConnection replies with {error: text} and makes no API call without a token', async () => {
	for (const message of [{}, { accessToken: '' }, 'testConnection', undefined]) {
		const reply = await testConnection(message, async () => {
			throw new Error('must not be called');
		});

		assert.deepEqual(reply, { error: 'No access token provided' });
	}
});

test('filterDevices selects everything when the filter is empty or missing', () => {
	for (const filter of [[], undefined, null, ['', '  ']]) {
		assert.deepEqual(filterDevices(['A', 'B'], filter), { selected: ['A', 'B'], unmatched: [] });
	}
});

test('filterDevices matches a site id that the admin chips field stored as a string (regression: every site was dropped)', () => {
	assert.deepEqual(filterDevices(['1234567890', '987'], ['1234567890']), {
		selected: ['1234567890'],
		unmatched: [],
	});
});

test('filterDevices still matches a site id stored as a number', () => {
	assert.deepEqual(filterDevices(['1234567890', '987'], [987]).selected, ['987']);
});

test('filterDevices matches a VIN typed in lower case or with stray spaces', () => {
	assert.deepEqual(filterDevices(['5YJ3E1EA7KF000001', '5YJ3E1EA7KF000002'], [' 5yj3e1ea7kf000002 ']), {
		selected: ['5YJ3E1EA7KF000002'],
		unmatched: [],
	});
});

test('filterDevices reports the filter entries that match no device', () => {
	assert.deepEqual(filterDevices(['5YJ3E1EA7KF000001'], ['5YJ3E1EA7KF000001', 'nope']), {
		selected: ['5YJ3E1EA7KF000001'],
		unmatched: ['nope'],
	});
	assert.deepEqual(filterDevices(['5YJ3E1EA7KF000001'], ['nope']), { selected: [], unmatched: ['nope'] });
});
