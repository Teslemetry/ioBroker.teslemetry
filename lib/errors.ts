import { STATUS_CODES } from 'node:http';
import { Teslemetry } from '@teslemetry/api';

// Statuses a user can act on, named for what they mean at Teslemetry.
const STATUS_NAMES: Record<number, string> = {
	401: 'Access token rejected',
	402: 'Subscription or credits required',
};

/**
 * The API's error envelope is `{response: null, error, error_description}`.
 */
function apiErrorDetail(body: unknown): string | undefined {
	const { error_description, error } = (body ?? {}) as Record<string, unknown>;
	return [error_description, error].find((value): value is string => typeof value === 'string' && value !== '');
}

/**
 * The SDK rejects a failed request with the parsed response body (a plain object
 * or a string), which carries neither a `message` nor the HTTP status. This makes
 * the client reject with an Error that names the status and the API's reason instead.
 */
export function withHttpErrors(teslemetry: Teslemetry): Teslemetry {
	teslemetry.client.interceptors.error.use((error, response) => {
		if (!response || response.ok) {
			return error;
		}
		const name = STATUS_NAMES[response.status] ?? STATUS_CODES[response.status] ?? 'Request failed';
		const detail = apiErrorDetail(error);
		return new Error(`${name} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
	});
	return teslemetry;
}

/**
 * Turns anything a Teslemetry call can reject with into text for a log line.
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) {
		// fetch reports every network failure as "fetch failed"; the reason is in the cause.
		const cause = error.cause as { message?: string; code?: string } | undefined;
		const reason = cause?.message || cause?.code;
		return reason ? `${error.message}: ${reason}` : error.message;
	}
	if (typeof error === 'string' && error !== '') {
		return error;
	}
	return apiErrorDetail(error) ?? 'Unknown error';
}
