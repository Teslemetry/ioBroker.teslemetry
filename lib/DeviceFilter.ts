/**
 * Applies a device selection from the admin page to the ids found on the account.
 *
 * The admin "chips" field stores whatever the user typed, as strings, so ids are
 * compared as trimmed, case-insensitive text: an energy site id matches whether it
 * was stored as a string or a number, and a VIN matches in any case. An empty
 * filter selects every device.
 */
export function filterDevices(ids: string[], filter: unknown): { selected: string[]; unmatched: string[] } {
	const normalize = (value: unknown): string => String(value).trim().toUpperCase();
	const entries = (Array.isArray(filter) ? filter : []).filter((entry) => entry != null && normalize(entry) !== '');

	if (entries.length === 0) {
		return { selected: ids, unmatched: [] };
	}

	const wanted = new Set(entries.map(normalize));
	const known = new Set(ids.map(normalize));

	return {
		selected: ids.filter((id) => wanted.has(normalize(id))),
		unmatched: entries.filter((entry) => !known.has(normalize(entry))).map((entry) => String(entry).trim()),
	};
}
