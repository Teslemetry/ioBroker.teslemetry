import { describeError } from './errors.js';

interface Products {
	vehicles: Record<string, { name: string }>;
	energySites: Record<string, { name: string }>;
}

/**
 * Answers the admin page's "Test Connection" button.
 *
 * admin shows a string `error` as an error dialog and a string `result` as a
 * message; any other reply shape is shown as the word "Ok". The result lists the
 * VINs and site ids, which are what the device selection fields take.
 */
export async function testConnection(
	message: unknown,
	fetchProducts: (accessToken: string) => Promise<Products>
): Promise<{ result: string } | { error: string }> {
	const token = (message as { accessToken?: unknown } | null | undefined)?.accessToken;
	if (typeof token !== 'string' || !token) {
		return { error: 'No access token provided' };
	}

	try {
		const products = await fetchProducts(token);
		const vehicles = Object.entries(products.vehicles).map(([vin, v]) => `${v.name} (${vin})`);
		const sites = Object.entries(products.energySites).map(([id, s]) => `${s.name} (${id})`);

		return {
			result: [
				`Connected successfully! Found ${vehicles.length} vehicle(s) and ${sites.length} energy site(s).`,
				...(vehicles.length ? [`Vehicles: ${vehicles.join(', ')}`] : []),
				...(sites.length ? [`Energy sites: ${sites.join(', ')}`] : []),
			].join('\n'),
		};
	} catch (error) {
		return { error: `Connection failed: ${describeError(error)}` };
	}
}
