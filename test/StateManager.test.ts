import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateManager } from '../lib/StateManager.js';
import { createFakeAdapter } from './fakeAdapter.js';

test('updateVehicleData reads through the REST vehicleData() `{ response: {...} }` wrapper (regression: was reading the top-level object)', async () => {
	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);

	await stateManager.updateVehicleData('VIN1', {
		response: {
			charge_state: { battery_level: 55 },
			vehicle_state: { locked: true },
		},
	});

	assert.equal(states.get('vehicles.VIN1.charge.battery_level'), 55);
	assert.equal(states.get('vehicles.VIN1.state.locked'), true);
});

test('updateVehicleDataFromSignals reads the SSE flat PascalCase signal map (regression: SSE data was routed through the REST parser and never matched)', async () => {
	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);

	await stateManager.updateVehicleDataFromSignals('VIN1', {
		BatteryLevel: 62,
		Locked: false,
		InsideTemp: 21.5,
		SentryMode: 'SentryModeStateArmed',
	});

	assert.equal(states.get('vehicles.VIN1.charge.battery_level'), 62);
	assert.equal(states.get('vehicles.VIN1.state.locked'), false);
	assert.equal(states.get('vehicles.VIN1.climate.inside_temp'), 21.5);
	assert.equal(states.get('vehicles.VIN1.state.sentry_mode'), true);
});

test('updateVehicleDataFromSignals maps HvacLeft/HvacRightTemperatureRequest to driver/passenger on an LHD vehicle', async () => {
	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: 'VIN1', display_name: 'Test Car', rhd: false });

	await stateManager.updateVehicleDataFromSignals('VIN1', {
		HvacLeftTemperatureRequest: 22,
		HvacRightTemperatureRequest: 19,
	});

	assert.equal(states.get('vehicles.VIN1.climate.driver_temp_setting'), 22);
	assert.equal(states.get('vehicles.VIN1.climate.passenger_temp_setting'), 19);
});

test('updateVehicleDataFromSignals maps HvacLeft/HvacRightTemperatureRequest to passenger/driver on a RHD vehicle (regression: was always treating left as driver)', async () => {
	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: 'VIN1', display_name: 'Test Car', rhd: true });

	await stateManager.updateVehicleDataFromSignals('VIN1', {
		HvacLeftTemperatureRequest: 22,
		HvacRightTemperatureRequest: 19,
	});

	assert.equal(states.get('vehicles.VIN1.climate.passenger_temp_setting'), 22);
	assert.equal(states.get('vehicles.VIN1.climate.driver_temp_setting'), 19);
});

test('updateEnergySiteData reads the flat getLiveStatus()/getSiteInfo() response shape (regression: was reading a non-existent `live_status` wrapper)', async () => {
	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);

	await stateManager.updateEnergySiteData(123, {
		solar_power: 250,
		battery_power: -50,
		grid_status: 'Active',
		percentage_charged: 77,
	});

	assert.equal(states.get('energy.123.live.solar_power'), 250);
	assert.equal(states.get('energy.123.live.grid_status'), 'Active');
	assert.equal(states.get('energy.123.battery.percentage'), 77);
});

test('updateEnergySiteData surfaces tariff_id/tariff_content/tariff_content_v2 from the getSiteInfo() response shape', async () => {
	const { adapter, states } = createFakeAdapter();
	const stateManager = new StateManager(adapter);

	await stateManager.updateEnergySiteData(123, {
		tariff_id: 'PGE-EV2-A',
		tariff_content: { code: 'PGE-EV2-A' },
		tariff_content_v2: { code: 'PGE-EV2-A', utility: 'PG&E', currency: 'USD' },
	});

	assert.equal(states.get('energy.123.tariff.tariff_id'), 'PGE-EV2-A');
	assert.equal(states.get('energy.123.tariff.tariff_content'), JSON.stringify({ code: 'PGE-EV2-A' }));
	assert.equal(
		states.get('energy.123.tariff.tariff_content_v2'),
		JSON.stringify({ code: 'PGE-EV2-A', utility: 'PG&E', currency: 'USD' })
	);
});

test('writable states carry the limits and value lists the API enforces', async () => {
	const { adapter, objects } = createFakeAdapter();
	const stateManager = new StateManager(adapter);
	await stateManager.createVehicleStates({ vin: 'VIN1', display_name: 'Test Car' });
	await stateManager.createEnergySiteStates({ id: 42, site_name: 'Home' });

	const common = (id: string) => objects.get(id).common;
	assert.partialDeepStrictEqual(common('vehicles.VIN1.charge.charge_limit_soc'), { min: 50, max: 100, step: 1 });
	assert.partialDeepStrictEqual(common('vehicles.VIN1.climate.driver_temp_setting'), { min: 15, max: 28, step: 0.5 });
	assert.partialDeepStrictEqual(common('vehicles.VIN1.climate.passenger_temp_setting'), { min: 15, max: 28, step: 0.5 });
	assert.partialDeepStrictEqual(common('energy.42.operation.backup_reserve_percent'), { min: 0, max: 100 });
	assert.partialDeepStrictEqual(common('energy.42.operation.off_grid_reserve_percent'), { min: 0, max: 100 });
	assert.deepEqual(Object.keys(common('energy.42.operation.mode').states).sort(), ['autonomous', 'backup', 'self_consumption']);
});

test('limits reach a writable state whose object an earlier version already created', async () => {
	const { adapter, objects } = createFakeAdapter();
	objects.set('vehicles.VIN1.charge.charge_limit_soc', {
		type: 'state',
		common: { name: 'Charge Limit', type: 'number', role: 'level.battery', read: true, write: true, def: 80, unit: '%' },
		native: {},
	});

	await new StateManager(adapter).createVehicleStates({ vin: 'VIN1', display_name: 'Test Car' });

	assert.partialDeepStrictEqual(objects.get('vehicles.VIN1.charge.charge_limit_soc').common, { name: 'Charge Limit', min: 50, max: 100 });
});
