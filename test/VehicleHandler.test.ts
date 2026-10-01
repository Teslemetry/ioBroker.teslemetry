import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Teslemetry } from '@teslemetry/api';
import { VehicleHandler } from '../lib/VehicleHandler.js';
import { StateManager } from '../lib/StateManager.js';
import { createFakeAdapter } from './fakeAdapter.js';

const VIN = '5YJSA1E14FF000000';

test('registerVehicle does not throw when the SDK already discovered the vehicle (regression: adapter aborted at startup)', () => {
	const teslemetry = new Teslemetry('fake-token');
	// Simulates createProducts()'s get-or-create discovery, which runs before registerVehicle.
	teslemetry.api.getVehicle(VIN);

	const { adapter } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));

	assert.doesNotThrow(() => handler.registerVehicle(VIN));
});

const COMMAND_CASES: Array<[command: string, method: string, args: any[]]> = [
	['wake', 'wakeUp', []],
	['lock', 'lockDoors', []],
	['unlock', 'unlockDoors', []],
	['start_climate', 'startAutoConditioning', []],
	['stop_climate', 'stopAutoConditioning', []],
	['start_charging', 'startCharging', []],
	['stop_charging', 'stopCharging', []],
	['flash_lights', 'flashLights', []],
	['honk_horn', 'honkHorn', []],
	['open_frunk', 'actuateTrunk', ['front']],
	['open_trunk', 'actuateTrunk', ['rear']],
];

for (const [command, method, expectedArgs] of COMMAND_CASES) {
	test(`executeCommand("${command}") calls the real SDK method ${method}() (regression: was calling a non-existent snake_case method)`, async () => {
		const teslemetry = new Teslemetry('fake-token');
		const vehicle = teslemetry.api.getVehicle(VIN);

		let calledWith: any[] | undefined;
		(vehicle as any)[method] = (...args: any[]) => {
			calledWith = args;
			return Promise.resolve({});
		};

		const { adapter } = createFakeAdapter();
		const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
		handler.registerVehicle(VIN);

		await handler.executeCommand(VIN, command);

		assert.deepEqual(calledWith, expectedArgs);
	});
}

test('handleStateChange for charge_limit_soc calls setChargeLimit(percent) positionally', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);

	let calledWith: any[] | undefined;
	(vehicle as any).setChargeLimit = (...args: any[]) => {
		calledWith = args;
		return Promise.resolve({});
	};

	const { adapter } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	await handler.handleStateChange(VIN, 'charge', 'charge_limit_soc', 90);

	assert.deepEqual(calledWith, [90]);
});

test('handleStateChange for sentry_mode calls setSentryMode(boolean)', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);

	let calledWith: any[] | undefined;
	(vehicle as any).setSentryMode = (...args: any[]) => {
		calledWith = args;
		return Promise.resolve({});
	};

	const { adapter } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	await handler.handleStateChange(VIN, 'state', 'sentry_mode', true);

	assert.deepEqual(calledWith, [true]);
});

test('handleStateChange for driver_temp_setting calls setTemps(driver, passenger) positionally, preserving the other temp', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);

	let calledWith: any[] | undefined;
	(vehicle as any).setTemps = (...args: any[]) => {
		calledWith = args;
		return Promise.resolve({});
	};

	const { adapter } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car' });
	await adapter.setStateAsync(`vehicles.${VIN}.climate.passenger_temp_setting`, 19, true);

	const handler = new VehicleHandler(adapter, teslemetry, stateManager);
	handler.registerVehicle(VIN);

	await handler.handleStateChange(VIN, 'climate', 'driver_temp_setting', 22);

	assert.deepEqual(calledWith, [22, 19]);
});

test('handleStateChange for driver_temp_setting on a RHD vehicle sends setTemps(left, right) with the driver value in the right-side slot, preserving the other temp (regression: was always putting driver first)', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);

	let calledWith: any[] | undefined;
	(vehicle as any).setTemps = (...args: any[]) => {
		calledWith = args;
		return Promise.resolve({});
	};

	const { adapter } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car', rhd: true });
	await adapter.setStateAsync(`vehicles.${VIN}.climate.passenger_temp_setting`, 19, true);

	const handler = new VehicleHandler(adapter, teslemetry, stateManager);
	handler.registerVehicle(VIN);

	await handler.handleStateChange(VIN, 'climate', 'driver_temp_setting', 22);

	assert.deepEqual(calledWith, [19, 22]);
});

test('a rejected lock command restores state.locked to its prior value and propagates once, unlogged, to the caller', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).lockDoors = () => Promise.reject(new Error('vehicle unreachable'));

	const { adapter, states, logs } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car' });
	await adapter.setStateAsync(`vehicles.${VIN}.state.locked`, false, true);

	const handler = new VehicleHandler(adapter, teslemetry, stateManager);
	handler.registerVehicle(VIN);

	await assert.rejects(() => handler.handleStateChange(VIN, 'commands', 'lock', true), /vehicle unreachable/);

	assert.equal(states.get(`vehicles.${VIN}.state.locked`), false);
	assert.equal(logs.filter((l) => l.level === 'error').length, 0);
});

test('a successful lock command acks state.locked to true', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).lockDoors = () => Promise.resolve({});

	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car' });
	await adapter.setStateAsync(`vehicles.${VIN}.state.locked`, false, true);

	const handler = new VehicleHandler(adapter, teslemetry, stateManager);
	handler.registerVehicle(VIN);

	await handler.handleStateChange(VIN, 'commands', 'lock', true);

	assert.equal(states.get(`vehicles.${VIN}.state.locked`), true);
});

test('a lock command the API answers with result: false restores state.locked, fails with the reason and is not logged as done (regression: was acked as success)', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).unlockDoors = () => Promise.resolve({ response: { result: false, reason: 'could_not_wake_buses' } });

	const { adapter, states, logs } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car' });
	await adapter.setStateAsync(`vehicles.${VIN}.state.locked`, true, true);

	const handler = new VehicleHandler(adapter, teslemetry, stateManager);
	handler.registerVehicle(VIN);

	await assert.rejects(() => handler.handleStateChange(VIN, 'commands', 'unlock', true), /could_not_wake_buses/);

	assert.equal(states.get(`vehicles.${VIN}.state.locked`), true);
	assert.equal(logs.filter((l) => l.message.includes('Unlocked')).length, 0);
});

test('a command without a reconciled state fails on result: false too', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).honkHorn = () => Promise.resolve({ response: { result: false } });

	const { adapter, logs } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	await assert.rejects(() => handler.executeCommand(VIN, 'honk_horn'));
	assert.equal(logs.filter((l) => l.message.includes('Honked')).length, 0);
});

for (const reason of ['already_set', 'not_charging', 'requested']) {
	test(`result: false with the benign reason "${reason}" is a success`, async () => {
		const teslemetry = new Teslemetry('fake-token');
		const vehicle = teslemetry.api.getVehicle(VIN);
		const refused = () => Promise.resolve({ response: { result: false, reason } });
		(vehicle as any).stopCharging = refused;
		(vehicle as any).setChargeLimit = refused;

		const { adapter, states } = createFakeAdapter();
		const stateManager = new StateManager(adapter);
		await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car' });
		await adapter.setStateAsync(`vehicles.${VIN}.charge.charge_limit_soc`, 80, true);

		const handler = new VehicleHandler(adapter, teslemetry, stateManager);
		handler.registerVehicle(VIN);

		await handler.handleStateChange(VIN, 'commands', 'stop_charging', true);
		await handler.handleStateChange(VIN, 'charge', 'charge_limit_soc', 90);

		assert.equal(states.get(`vehicles.${VIN}.charge.charge_limit_soc`), 90);
	});
}

for (const [command, which, door] of [
	['open_frunk', 'front', 'TrunkFront'],
	['open_trunk', 'rear', 'TrunkRear'],
] as const) {
	const setup = (doorState: any) => {
		const teslemetry = new Teslemetry('fake-token');
		const vehicle = teslemetry.api.getVehicle(VIN);
		const calls: any[][] = [];
		(vehicle as any).actuateTrunk = (...args: any[]) => {
			calls.push(args);
			return Promise.resolve({ response: { result: true } });
		};
		if (doorState !== undefined) teslemetry.sse.cache[VIN] = { data: { DoorState: doorState } };

		const { adapter } = createFakeAdapter();
		const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
		handler.registerVehicle(VIN);
		return { handler, calls };
	};
	const doors = { DriverFront: false, DriverRear: false, PassengerFront: false, PassengerRear: false, TrunkFront: false, TrunkRear: false };

	test(`${command} sends nothing when the stream reports it open (regression: actuate_trunk is a toggle and closed it)`, async () => {
		const { handler, calls } = setup({ ...doors, [door]: true });
		await handler.executeCommand(VIN, command);
		assert.deepEqual(calls, []);
	});

	test(`${command} is sent when the stream reports it closed`, async () => {
		const { handler, calls } = setup({ ...doors, TrunkFront: true, TrunkRear: true, [door]: false });
		await handler.executeCommand(VIN, command);
		assert.deepEqual(calls, [[which]]);
	});

	for (const unknown of [undefined, null]) {
		test(`${command} is still sent while its state is unknown (DoorState ${unknown})`, async () => {
			const { handler, calls } = setup(unknown);
			await handler.executeCommand(VIN, command);
			assert.deepEqual(calls, [[which]]);
		});
	}
}

test('a pressed command button is acknowledged and reset, whether the command works or fails (regression: stayed val true, ack false)', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).flashLights = () => Promise.resolve({ response: { result: true } });
	(vehicle as any).honkHorn = () => Promise.reject(new Error('vehicle unreachable'));

	const { adapter, states } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	await adapter.setStateAsync(`vehicles.${VIN}.commands.flash_lights`, true);
	await handler.handleStateChange(VIN, 'commands', 'flash_lights', true);
	assert.equal(states.get(`vehicles.${VIN}.commands.flash_lights`), false);

	await adapter.setStateAsync(`vehicles.${VIN}.commands.honk_horn`, true);
	await assert.rejects(() => handler.handleStateChange(VIN, 'commands', 'honk_horn', true), /vehicle unreachable/);
	assert.equal(states.get(`vehicles.${VIN}.commands.honk_horn`), false);
});

test('a rejected temperature write restores driver_temp_setting to its prior value and propagates once, unlogged, to the caller', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).setTemps = () => Promise.reject(new Error('command rejected'));

	const { adapter, states, logs } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: VIN, display_name: 'Test Car' });
	await adapter.setStateAsync(`vehicles.${VIN}.climate.driver_temp_setting`, 21, true);
	await adapter.setStateAsync(`vehicles.${VIN}.climate.passenger_temp_setting`, 19, true);

	const handler = new VehicleHandler(adapter, teslemetry, stateManager);
	handler.registerVehicle(VIN);

	await assert.rejects(() => handler.handleStateChange(VIN, 'climate', 'driver_temp_setting', 25), /command rejected/);

	assert.equal(states.get(`vehicles.${VIN}.climate.driver_temp_setting`), 21);
	assert.equal(logs.filter((l) => l.level === 'error').length, 0);
});

test('fetchVehicleData reads state from the response wrapper and skips vehicleData() while asleep', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);

	let vehicleDataCalled = false;
	(vehicle as any).state = () => Promise.resolve({ response: { state: 'asleep' } });
	(vehicle as any).vehicleData = () => {
		vehicleDataCalled = true;
		return Promise.resolve({ response: {} });
	};

	const { adapter, states } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	await handler.fetchVehicleData(VIN, false);

	assert.equal(states.get(`vehicles.${VIN}._info.state`), 'asleep');
	assert.equal(vehicleDataCalled, false);
});

test('fetchVehicleData logs the API\'s error_description and reports failure (regression: logged "undefined")', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	// The SDK rejects with the parsed response body, not an Error.
	(vehicle as any).state = () =>
		Promise.reject({ response: null, error: 'payment_required', error_description: 'Subscription required' });

	const { adapter, logs } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	assert.deepEqual(await handler.fetchAllVehicleData(false), [false]);
	assert.deepEqual(
		logs.filter((l) => l.level === 'error').map((l) => l.message),
		[`Error fetching data for vehicle ${VIN}: Subscription required`]
	);
});

test('fetchAllVehicleData reports success for an asleep vehicle (the API answered)', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	(vehicle as any).state = () => Promise.resolve({ response: { state: 'asleep' } });

	const { adapter } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	assert.deepEqual(await handler.fetchAllVehicleData(false), [true]);
});

test('a fetch pending when the adapter stops writes no states (regression: wrote after unload)', async () => {
	const teslemetry = new Teslemetry('fake-token');
	const vehicle = teslemetry.api.getVehicle(VIN);
	let answer!: (value: unknown) => void;
	(vehicle as any).state = () => new Promise((resolve) => (answer = resolve));

	const { adapter, states } = createFakeAdapter();
	const handler = new VehicleHandler(adapter, teslemetry, new StateManager(adapter));
	handler.registerVehicle(VIN);

	const fetch = handler.fetchVehicleData(VIN, false);
	handler.stop();
	answer({ response: { state: 'online' } });

	assert.equal(await fetch, false);
	assert.equal(states.size, 0);
});
