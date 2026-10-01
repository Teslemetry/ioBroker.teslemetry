/**
 * Whether a round of device requests shows the API is reachable: connected
 * unless every request failed.
 */
export function connectedAfter(results: boolean[]): boolean {
	return results.length === 0 || results.includes(true);
}
