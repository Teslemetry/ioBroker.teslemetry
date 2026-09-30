import * as utils from '@iobroker/adapter-core';
import { Teslemetry } from '@teslemetry/api';
import { StateManager } from '../lib/StateManager.js';
import { VehicleHandler } from '../lib/VehicleHandler.js';
import { EnergyHandler } from '../lib/EnergyHandler.js';
import { StreamHandler } from '../lib/StreamHandler.js';
import { describeError, withHttpErrors } from '../lib/errors.js';

// Start-up is retried after 10s, doubling up to 10 minutes.
const START_RETRY_BASE_MS = 10_000;
const START_RETRY_MAX_MS = 600_000;

// Matches the "native" config schema in io-package.json / admin/jsonConfig.json.
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			accessToken: string;
			region: 'auto' | 'na' | 'eu';
			pollInterval: number;
			enableStreaming: boolean;
			selectedVehicles: string[];
			selectedEnergySites: number[];
		}
	}
}

class TeslemetryAdapter extends utils.Adapter {
	private teslemetry?: Teslemetry;
	private stateManager?: StateManager;
	private vehicleHandler?: VehicleHandler;
	private energyHandler?: EnergyHandler;
	private streamHandler?: StreamHandler;
	private pollInterval?: ioBroker.Interval;
	private startRetry?: ioBroker.Timeout;
	private startAttempts = 0;
	// Set on unload: the database is closed from then on, so nothing may touch states or objects.
	private unloaded = false;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'teslemetry',
		});

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when adapter is ready
	 */
	private async onReady(): Promise<void> {
		this.log.info('Starting Teslemetry adapter...');

		// Validate configuration
		if (!this.config.accessToken) {
			this.log.error('No access token configured. Please configure the adapter in the admin interface.');
			return;
		}

		try {
			// Initialize Teslemetry client
			this.log.info('Initializing Teslemetry client...');
			this.teslemetry = withHttpErrors(
				new Teslemetry(this.config.accessToken, {
					region: this.config.region === 'auto' ? undefined : this.config.region,
				})
			);

			// Initialize handlers
			this.stateManager = new StateManager(this);
			this.vehicleHandler = new VehicleHandler(this, this.teslemetry, this.stateManager);
			this.energyHandler = new EnergyHandler(this, this.teslemetry, this.stateManager);

			// Fetch products
			this.log.info('Fetching Tesla products...');
			const products = await this.teslemetry.createProducts();
			if (this.unloaded) return;
			const { vehicles, energySites } = products;

			// Create state objects for vehicles
			const selectedVehicles = this.config.selectedVehicles || [];
			const vehicleEntries = Object.entries(vehicles);

			if (vehicleEntries.length === 0) {
				this.log.warn('No vehicles found in your Tesla account');
			} else {
				for (const [vin, vehicle] of vehicleEntries) {
					// If no selection made, include all vehicles
					if (selectedVehicles.length === 0 || selectedVehicles.includes(vin)) {
						this.log.info(`Setting up vehicle: ${vehicle.name} (${vin})`);
						await this.stateManager.createVehicleStates({
							vin,
							display_name: vehicle.name,
							rhd: vehicle.metadata.config?.rhd ?? undefined,
						});
						if (this.unloaded) return;
						this.vehicleHandler.registerVehicle(vin);
					}
				}
			}

			// Create state objects for energy sites
			const selectedSites = this.config.selectedEnergySites || [];
			const siteEntries = Object.entries(energySites);

			if (siteEntries.length === 0) {
				this.log.info('No energy sites found in your Tesla account');
			} else {
				for (const [id, site] of siteEntries) {
					const siteId = Number(id);
					// If no selection made, include all sites
					if (selectedSites.length === 0 || selectedSites.includes(siteId)) {
						this.log.info(`Setting up energy site: ${site.name} (${siteId})`);
						await this.stateManager.createEnergySiteStates({
							id: siteId,
							site_name: site.name,
						});
						if (this.unloaded) return;
						this.energyHandler.registerSite(siteId);
					}
				}
			}

			// Subscribe to all state changes
			this.subscribeStates('*');

			// Seed energy state before opening the stream - connect() only starts the SDK's
			// background loop and returns immediately, so a stream event could otherwise land
			// before this REST fetch resolves and get overwritten by the stale snapshot.
			this.log.info('Fetching initial energy site data...');
			await this.energyHandler.fetchAllSiteData();
			if (this.unloaded) return;

			// Set up streaming or polling
			if (this.config.enableStreaming !== false) {
				this.log.info('Starting SSE streaming...');
				this.streamHandler = new StreamHandler(this, this.teslemetry, this.stateManager, this.energyHandler);
				await this.streamHandler.connect();
				if (this.unloaded) return;
			} else {
				this.log.info('SSE streaming disabled, using polling');
				this.startPolling();
			}

			// Do initial vehicle data fetch
			this.log.info('Fetching initial vehicle data...');
			await this.vehicleHandler.fetchAllVehicleData(false);
			if (this.unloaded) return;

			this.startAttempts = 0;
			this.log.info('Teslemetry adapter started successfully');
			// While streaming, info.connection follows the stream (see StreamHandler).
			if (!this.streamHandler) {
				await this.setStateAsync('info.connection', true, true);
			}
		} catch (error) {
			// A stop during start-up closes the database under the awaits above;
			// there is nothing to report or retry then.
			if (this.unloaded) return;

			this.stopDataSources();
			const delay = Math.min(START_RETRY_BASE_MS * 2 ** this.startAttempts++, START_RETRY_MAX_MS);
			this.log.error(`Failed to start adapter: ${describeError(error)}. Retrying in ${delay / 1000}s.`);
			this.startRetry = this.setTimeout(() => {
				this.startRetry = undefined;
				void this.onReady();
			}, delay);
			try {
				await this.setStateAsync('info.connection', false, true);
			} catch {
				// The database can close between the check above and this write.
			}
		}
	}

	/**
	 * Stop polling and streaming
	 */
	private stopDataSources(): void {
		if (this.pollInterval) {
			this.clearInterval(this.pollInterval);
			this.pollInterval = undefined;
		}

		// StreamHandler.disconnect() also closes the underlying SSE connection -
		// no separate teslemetry.sse.disconnect() needed
		if (this.streamHandler) {
			this.streamHandler.disconnect();
			this.streamHandler = undefined;
		} else if (this.teslemetry) {
			this.teslemetry.sse.disconnect();
		}
	}

	/**
	 * Is called when adapter shuts down
	 */
	private onUnload(callback: () => void): void {
		try {
			this.unloaded = true;
			this.log.info('Cleaning up...');

			if (this.startRetry) {
				this.clearTimeout(this.startRetry);
				this.startRetry = undefined;
			}
			this.stopDataSources();

			callback();
		} catch {
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 */
	private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
		if (!state || state.ack) {
			// Ignore state changes that are acknowledged (from adapter) or null
			return;
		}

		this.log.debug(`State change: ${id} = ${state.val}`);

		// Parse the state ID to determine what to do
		const parsed = this.stateManager?.parseStateId(id);
		if (!parsed) {
			this.log.warn(`Could not parse state ID: ${id}`);
			return;
		}

		const { type, identifier, category, state: stateName } = parsed;

		try {
			if (type === 'vehicle') {
				await this.vehicleHandler?.handleStateChange(identifier, category, stateName, state.val);
			} else if (type === 'energy') {
				await this.energyHandler?.handleStateChange(Number(identifier), category, stateName, state.val);
			}
		} catch (error) {
			this.log.error(`Error handling state change: ${describeError(error)}`);
		}
	}

	/**
	 * Handle messages from admin UI
	 */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		if (typeof obj === 'object' && obj.message) {
			if (obj.command === 'testConnection') {
				try {
					const token = obj.message.accessToken;
					if (!token) {
						this.sendTo(obj.from, obj.command, { error: 'No access token provided' }, obj.callback);
						return;
					}

					// Test connection by creating a Teslemetry client and fetching products
					const testClient = withHttpErrors(new Teslemetry(token));
					const products = await testClient.createProducts();

					const vehicleCount = Object.keys(products.vehicles).length;
					const siteCount = Object.keys(products.energySites).length;

					this.sendTo(
						obj.from,
						obj.command,
						{
							success: true,
							message: `Connected successfully! Found ${vehicleCount} vehicle(s) and ${siteCount} energy site(s).`,
							vehicles: Object.entries(products.vehicles).map(([vin, v]) => ({
								vin,
								name: v.name,
							})),
							energySites: Object.entries(products.energySites).map(([id, s]) => ({
								id: Number(id),
								name: s.name,
							})),
						},
						obj.callback
					);
				} catch (error) {
					this.sendTo(
						obj.from,
						obj.command,
						{
							error: `Connection failed: ${describeError(error)}`,
						},
						obj.callback
					);
				}
			}
		}
	}

	/**
	 * Start polling for data updates
	 */
	private startPolling(): void {
		const interval = (this.config.pollInterval || 60) * 1000;
		this.log.info(`Starting polling with interval: ${interval / 1000}s`);

		this.pollInterval = this.setInterval(async () => {
			try {
				const results = [
					...((await this.vehicleHandler?.fetchAllVehicleData(false)) ?? []),
					...((await this.energyHandler?.fetchAllSiteData()) ?? []),
				];
				if (this.unloaded) return;
				// Connected unless every request of this round failed.
				await this.setStateAsync('info.connection', results.length === 0 || results.includes(true), true);
			} catch (error) {
				this.log.error(`Error during polling: ${describeError(error)}`);
			}
		}, interval);
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new TeslemetryAdapter(options);
} else {
	// otherwise start the instance directly
	(() => new TeslemetryAdapter())();
}
