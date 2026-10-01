import { Teslemetry, TeslemetryEnergyApi } from '@teslemetry/api';
import { StateManager } from './StateManager.js';
import { describeError } from './errors.js';

export class EnergyHandler {
	private sites: Map<number, TeslemetryEnergyApi> = new Map();

	constructor(
		private adapter: ioBroker.Adapter,
		private teslemetry: Teslemetry,
		private stateManager: StateManager
	) {}

	// Set by stop(); a fetch still awaiting the API then writes nothing.
	private stopped = false;

	/**
	 * Stops pending fetches from writing states once the adapter unloads
	 */
	stop(): void {
		this.stopped = true;
	}

	/**
	 * Register an energy site for handling
	 */
	registerSite(siteId: number): void {
		// api.getEnergySite is get-or-create; createProducts() already created this
		// entry, so the constructor's `new TeslemetryEnergyApi` guard would throw.
		this.sites.set(siteId, this.teslemetry.api.getEnergySite(siteId));
		this.adapter.log.info(`Registered energy site: ${siteId}`);
	}

	/**
	 * Runs a write against the energy site, acking the requested value on success.
	 * A rejected write restores the last confirmed value so the object state never
	 * shows a requested value that was never actually applied.
	 */
	private async writeAndReconcile(id: string, value: any, write: () => Promise<any>): Promise<void> {
		const prior = await this.adapter.getStateAsync(id);
		try {
			await write();
		} catch (error) {
			await this.adapter.setStateAsync(id, prior?.val ?? null, true);
			throw error;
		}
		await this.adapter.setStateAsync(id, value, true);
	}

	/**
	 * Execute an energy site command
	 */
	async executeCommand(siteId: number, command: string, params?: any): Promise<void> {
		const site = this.sites.get(siteId);
		if (!site) {
			this.adapter.log.error(`Energy site ${siteId} not registered`);
			return;
		}

		this.adapter.log.debug(`Executing command ${command} for energy site ${siteId}`);

		switch (command) {
			case 'storm_mode':
				if (params?.enabled !== undefined) {
					await site.setStormMode(params.enabled);
					this.adapter.log.info(`Set storm mode to ${params.enabled} for site ${siteId}`);
				}
				break;

			default:
				this.adapter.log.warn(`Unknown command: ${command}`);
		}
	}

	/**
	 * Handle state change for energy site
	 */
	async handleStateChange(siteId: number, category: string, stateName: string, value: any): Promise<void> {
		const site = this.sites.get(siteId);
		if (!site) {
			this.adapter.log.error(`Energy site ${siteId} not registered`);
			return;
		}

		// Handle commands
		if (category === 'commands') {
			if (stateName === 'storm_mode') {
				await this.executeCommand(siteId, 'storm_mode', { enabled: value });
			}
			return;
		}

		// Handle writable operation states
		if (category === 'operation') {
			if (stateName === 'mode') {
				await this.writeAndReconcile(`energy.${siteId}.operation.mode`, value, () => site.setOperationMode(value));
				this.adapter.log.info(`Set operation mode to ${value} for site ${siteId}`);
			} else if (stateName === 'backup_reserve_percent') {
				await this.writeAndReconcile(`energy.${siteId}.operation.backup_reserve_percent`, value, () => site.setBackupReserve(value));
				this.adapter.log.info(`Set backup reserve to ${value}% for site ${siteId}`);
			} else if (stateName === 'off_grid_reserve_percent') {
				await this.writeAndReconcile(`energy.${siteId}.operation.off_grid_reserve_percent`, value, () =>
					site.setOffGridVehicleChargingReserve(value)
				);
				this.adapter.log.info(`Set off-grid reserve to ${value}% for site ${siteId}`);
			}
		}
	}

	/**
	 * Fetch energy site data and update states. Resolves to whether the API answered.
	 */
	async fetchSiteData(siteId: number): Promise<boolean> {
		const site = this.sites.get(siteId);
		if (!site) {
			this.adapter.log.error(`Energy site ${siteId} not registered`);
			return false;
		}

		try {
			// Fetch site status (power/battery/grid) and site info (operation settings)
			const [liveStatus, siteInfo] = await Promise.all([site.getLiveStatus(), site.getSiteInfo()]);
			if (this.stopped) return false;
			await this.stateManager.updateEnergySiteData(siteId, {
				...siteInfo?.response,
				...liveStatus?.response,
			});
			this.adapter.log.debug(`Updated data for energy site ${siteId}`);
			return true;
		} catch (error) {
			this.adapter.log.error(`Error fetching data for site ${siteId}: ${describeError(error)}`);
			return false;
		}
	}

	/**
	 * Fetch data for all registered energy sites. Resolves to each fetch's outcome.
	 */
	async fetchAllSiteData(): Promise<boolean[]> {
		const promises = Array.from(this.sites.keys()).map((siteId) =>
			this.fetchSiteData(siteId)
		);
		return Promise.all(promises);
	}

	/**
	 * Get list of registered site IDs
	 */
	getRegisteredSites(): number[] {
		return Array.from(this.sites.keys());
	}
}
