import { Teslemetry, TeslemetryVehicleApi } from '@teslemetry/api';
import { StateManager } from './StateManager.js';
import { describeError } from './errors.js';

// Reasons Tesla gives with `result: false` when the vehicle is already in the
// requested state or has accepted the request; they are not failures.
const BENIGN_REASONS = new Set(['already_set', 'not_charging', 'requested']);

/**
 * The API answers a command the vehicle refused with HTTP 200 and
 * `result: false`, so a resolved promise alone does not mean it was applied.
 */
function assertAccepted(result: { response?: { result?: boolean; reason?: string } }): void {
	const response = result?.response;
	if (response?.result !== false || BENIGN_REASONS.has(response.reason ?? '')) return;
	throw new Error(`Command refused by the vehicle: ${response.reason || 'no reason given'}`);
}

export class VehicleHandler {
	private vehicles: Map<string, TeslemetryVehicleApi> = new Map();

	constructor(
		private adapter: ioBroker.Adapter,
		private teslemetry: Teslemetry,
		private stateManager: StateManager
	) {}

	/**
	 * Register a vehicle for handling
	 */
	registerVehicle(vin: string): void {
		// api.getVehicle is get-or-create; createProducts() already created this
		// entry, so the constructor's `new TeslemetryVehicleApi` guard would throw.
		this.vehicles.set(vin, this.teslemetry.api.getVehicle(vin));
		this.adapter.log.info(`Registered vehicle: ${vin}`);
	}

	/**
	 * Runs a write against the vehicle, acking the requested value on success. A
	 * rejected write restores the last confirmed value so the object state never
	 * shows a requested value that was never actually applied.
	 */
	private async writeAndReconcile(id: string, value: any, write: () => Promise<any>): Promise<void> {
		const prior = await this.adapter.getStateAsync(id);
		try {
			assertAccepted(await write());
		} catch (error) {
			await this.adapter.setStateAsync(id, prior?.val ?? null, true);
			throw error;
		}
		await this.adapter.setStateAsync(id, value, true);
	}

	/**
	 * Execute a vehicle command
	 */
	async executeCommand(vin: string, command: string, _params?: any): Promise<void> {
		const vehicle = this.vehicles.get(vin);
		if (!vehicle) {
			this.adapter.log.error(`Vehicle ${vin} not registered`);
			return;
		}

		this.adapter.log.debug(`Executing command ${command} for vehicle ${vin}`);

		switch (command) {
			case 'wake':
				await vehicle.wakeUp();
				this.adapter.log.info(`Woke up vehicle ${vin}`);
				break;

			case 'lock':
				await this.writeAndReconcile(`vehicles.${vin}.state.locked`, true, () => vehicle.lockDoors());
				this.adapter.log.info(`Locked vehicle ${vin}`);
				break;

			case 'unlock':
				await this.writeAndReconcile(`vehicles.${vin}.state.locked`, false, () => vehicle.unlockDoors());
				this.adapter.log.info(`Unlocked vehicle ${vin}`);
				break;

			case 'start_climate':
				await this.writeAndReconcile(`vehicles.${vin}.climate.is_climate_on`, true, () => vehicle.startAutoConditioning());
				this.adapter.log.info(`Started climate for vehicle ${vin}`);
				break;

			case 'stop_climate':
				await this.writeAndReconcile(`vehicles.${vin}.climate.is_climate_on`, false, () => vehicle.stopAutoConditioning());
				this.adapter.log.info(`Stopped climate for vehicle ${vin}`);
				break;

			case 'start_charging':
				assertAccepted(await vehicle.startCharging());
				this.adapter.log.info(`Started charging for vehicle ${vin}`);
				break;

			case 'stop_charging':
				assertAccepted(await vehicle.stopCharging());
				this.adapter.log.info(`Stopped charging for vehicle ${vin}`);
				break;

			case 'flash_lights':
				assertAccepted(await vehicle.flashLights());
				this.adapter.log.info(`Flashed lights for vehicle ${vin}`);
				break;

			case 'honk_horn':
				assertAccepted(await vehicle.honkHorn());
				this.adapter.log.info(`Honked horn for vehicle ${vin}`);
				break;

			case 'open_frunk':
				await this.openTrunk(vin, vehicle, 'front');
				break;

			case 'open_trunk':
				await this.openTrunk(vin, vehicle, 'rear');
				break;

			default:
				this.adapter.log.warn(`Unknown command: ${command}`);
		}
	}

	/**
	 * actuate_trunk is a toggle, so it is not sent when the stream reports the
	 * trunk already open. An unknown state still sends it.
	 */
	private async openTrunk(vin: string, vehicle: TeslemetryVehicleApi, which: 'front' | 'rear'): Promise<void> {
		const name = which === 'front' ? 'frunk' : 'trunk';
		const doors = this.teslemetry.sse.cache[vin]?.data?.DoorState;
		if (doors?.[which === 'front' ? 'TrunkFront' : 'TrunkRear'] === true) {
			this.adapter.log.info(`The ${name} of vehicle ${vin} is already open, command not sent`);
			return;
		}
		assertAccepted(await vehicle.actuateTrunk(which));
		this.adapter.log.info(`Opened ${name} for vehicle ${vin}`);
	}

	/**
	 * Handle state change for vehicle
	 */
	async handleStateChange(vin: string, category: string, stateName: string, value: any): Promise<void> {
		const vehicle = this.vehicles.get(vin);
		if (!vehicle) {
			this.adapter.log.error(`Vehicle ${vin} not registered`);
			return;
		}

		// Handle commands
		if (category === 'commands') {
			try {
				if (value === true || value === 'true') {
					await this.executeCommand(vin, stateName);
				}
			} finally {
				// A button holds no value: acknowledge the press and reset it, whatever the outcome.
				await this.adapter.setStateAsync(`vehicles.${vin}.commands.${stateName}`, false, true);
			}
			return;
		}

		// Handle writable states
		if (category === 'climate') {
			if (stateName === 'driver_temp_setting' || stateName === 'passenger_temp_setting') {
				// setTemps takes both temps positionally, so read the other one's
				// current value to avoid clobbering it.
				const [driverState, passengerState] = await Promise.all([
					this.adapter.getStateAsync(`vehicles.${vin}.climate.driver_temp_setting`),
					this.adapter.getStateAsync(`vehicles.${vin}.climate.passenger_temp_setting`),
				]);
				const driverTemp = stateName === 'driver_temp_setting' ? value : (driverState?.val ?? 21);
				const passengerTemp = stateName === 'passenger_temp_setting' ? value : (passengerState?.val ?? 21);
				// setTemps's positional args are physical left/right seats, not driver/passenger -
				// on RHD vehicles the driver sits on the right.
				const rhd = this.stateManager.isRhd(vin);
				const leftTemp = rhd ? passengerTemp : driverTemp;
				const rightTemp = rhd ? driverTemp : passengerTemp;
				await this.writeAndReconcile(`vehicles.${vin}.climate.${stateName}`, value, () => vehicle.setTemps(leftTemp, rightTemp));
				this.adapter.log.info(`Set temps to ${driverTemp}/${passengerTemp}°C for vehicle ${vin}`);
			}
		} else if (category === 'charge') {
			if (stateName === 'charge_limit_soc') {
				await this.writeAndReconcile(`vehicles.${vin}.charge.charge_limit_soc`, value, () => vehicle.setChargeLimit(value));
				this.adapter.log.info(`Set charge limit to ${value}% for vehicle ${vin}`);
			}
		} else if (category === 'state') {
			if (stateName === 'sentry_mode') {
				await this.writeAndReconcile(`vehicles.${vin}.state.sentry_mode`, !!value, () => vehicle.setSentryMode(!!value));
				this.adapter.log.info(`Set sentry mode to ${value} for vehicle ${vin}`);
			}
		}
	}

	/**
	 * Fetch vehicle data and update states. Resolves to whether the API answered.
	 */
	async fetchVehicleData(vin: string, allowWake = false): Promise<boolean> {
		const vehicle = this.vehicles.get(vin);
		if (!vehicle) {
			this.adapter.log.error(`Vehicle ${vin} not registered`);
			return false;
		}

		try {
			// Get vehicle state first (doesn't wake vehicle)
			const stateResult = await vehicle.state();
			const state = stateResult?.response?.state ?? 'unknown';
			await this.adapter.setStateAsync(`vehicles.${vin}._info.state`, state, true);

			// Only fetch data if vehicle is online or we're allowed to wake it
			if (state === 'asleep' && !allowWake) {
				this.adapter.log.debug(`Vehicle ${vin} is asleep, skipping data fetch`);
				return true;
			}

			// Fetch vehicle data
			const data = await vehicle.vehicleData();
			await this.stateManager.updateVehicleData(vin, data);
			this.adapter.log.debug(`Updated data for vehicle ${vin}`);
			return true;
		} catch (error) {
			this.adapter.log.error(`Error fetching data for vehicle ${vin}: ${describeError(error)}`);
			return false;
		}
	}

	/**
	 * Fetch data for all registered vehicles. Resolves to each fetch's outcome.
	 */
	async fetchAllVehicleData(allowWake = false): Promise<boolean[]> {
		const promises = Array.from(this.vehicles.keys()).map((vin) =>
			this.fetchVehicleData(vin, allowWake)
		);
		return Promise.all(promises);
	}

	/**
	 * Get list of registered vehicle VINs
	 */
	getRegisteredVehicles(): string[] {
		return Array.from(this.vehicles.keys());
	}
}
