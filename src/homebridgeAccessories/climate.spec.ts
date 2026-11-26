import { describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { Subject } from 'rxjs';
import {
    ClimateAction,
    ClimateComponent,
    ClimateFanMode,
    ClimateMode,
    ClimatePreset,
    ClimateSwingMode,
    MessageTypes,
    TemperatureUnit,
} from 'esphome-ts';
import type { BaseComponent, ClimateEntity, ClimateStateEvent, CommandInterface } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { climateHelper } from './climate.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    FakeHapStatusError,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    type FakeHapCharacteristic,
    type FakeHapCharacteristicConstructor,
    type FakeHapService,
} from '../testing/hapFakes.js';

const CURRENT_HEATING_COOLING = Object.assign(makeFakeCharacteristicClass('current-heating-cooling-uuid'), {
    OFF: 0,
    HEAT: 1,
    COOL: 2,
});
const TARGET_HEATING_COOLING = Object.assign(makeFakeCharacteristicClass('target-heating-cooling-uuid'), {
    OFF: 0,
    HEAT: 1,
    COOL: 2,
    AUTO: 3,
});
const CURRENT_TEMPERATURE = makeFakeCharacteristicClass('current-temperature-uuid');
const TARGET_TEMPERATURE = makeFakeCharacteristicClass('target-temperature-uuid');
const TEMPERATURE_DISPLAY_UNITS = Object.assign(makeFakeCharacteristicClass('temperature-display-units-uuid'), {
    CELSIUS: 0,
    FAHRENHEIT: 1,
});
const CURRENT_HUMIDITY = makeFakeCharacteristicClass('current-humidity-uuid');
const TARGET_HUMIDITY = makeFakeCharacteristicClass('target-humidity-uuid');
const COOLING_THRESHOLD = makeFakeCharacteristicClass('cooling-threshold-uuid');
const HEATING_THRESHOLD = makeFakeCharacteristicClass('heating-threshold-uuid');
const ACTIVE = Object.assign(makeFakeCharacteristicClass('active-uuid'), { INACTIVE: 0, ACTIVE: 1 });
const ROTATION_SPEED = makeFakeCharacteristicClass('rotation-speed-uuid');
/** Carries the valid-value statics real hap defines on the fan classes themselves. */
const TARGET_FAN_STATE = Object.assign(makeFakeCharacteristicClass('target-fan-state-uuid'), {
    MANUAL: 0,
    AUTO: 1,
});
const CURRENT_FAN_STATE = Object.assign(makeFakeCharacteristicClass('current-fan-state-uuid'), {
    INACTIVE: 0,
    IDLE: 1,
    BLOWING_AIR: 2,
});
const SWING_MODE = Object.assign(makeFakeCharacteristicClass('swing-mode-uuid'), {
    SWING_DISABLED: 0,
    SWING_ENABLED: 1,
});

/** Mandatory set mirrors real hap Service.Thermostat (ServiceDefinitions.js:1177-1181). */
const ThermostatService = makeFakeServiceClass('thermostat-service-uuid', [
    CURRENT_HEATING_COOLING,
    TARGET_HEATING_COOLING,
    CURRENT_TEMPERATURE,
    TARGET_TEMPERATURE,
    TEMPERATURE_DISPLAY_UNITS,
]);
/** Mandatory set mirrors real hap Service.Fanv2 (ServiceDefinitions.js:444). */
const Fanv2Service = makeFakeServiceClass('fanv2-service-uuid', [ACTIVE]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { Thermostat: ThermostatService, Fanv2: Fanv2Service },
            Characteristic: {
                CurrentHeatingCoolingState: CURRENT_HEATING_COOLING,
                TargetHeatingCoolingState: TARGET_HEATING_COOLING,
                CurrentTemperature: CURRENT_TEMPERATURE,
                TargetTemperature: TARGET_TEMPERATURE,
                TemperatureDisplayUnits: TEMPERATURE_DISPLAY_UNITS,
                CurrentRelativeHumidity: CURRENT_HUMIDITY,
                TargetRelativeHumidity: TARGET_HUMIDITY,
                CoolingThresholdTemperature: COOLING_THRESHOLD,
                HeatingThresholdTemperature: HEATING_THRESHOLD,
                Active: ACTIVE,
                RotationSpeed: ROTATION_SPEED,
                TargetFanState: TARGET_FAN_STATE,
                CurrentFanState: CURRENT_FAN_STATE,
                SwingMode: SWING_MODE,
            },
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

/** A full ClimateEntity with per-test overrides, defaulting to a plain single-setpoint thermostat. */
const baseEntity = (overrides: Partial<ClimateEntity> = {}): ClimateEntity => ({
    key: 1,
    name: 'TestClimate',
    uniqueId: 'climate-1',
    objectId: 'test_climate',
    supportsCurrentTemperature: true,
    supportsTwoPointTargetTemperature: false,
    supportedModes: [
        ClimateMode.CLIMATE_MODE_OFF,
        ClimateMode.CLIMATE_MODE_HEAT_COOL,
        ClimateMode.CLIMATE_MODE_COOL,
        ClimateMode.CLIMATE_MODE_HEAT,
        ClimateMode.CLIMATE_MODE_AUTO,
    ],
    visualMinTemperature: 7,
    visualMaxTemperature: 30,
    visualTargetTemperatureStep: 0.5,
    legacySupportsAway: false,
    supportsAction: true,
    supportedFanModes: [],
    supportedSwingModes: [],
    supportedCustomFanModes: [],
    supportedPresets: [],
    supportedCustomPresets: [],
    supportsCurrentHumidity: false,
    supportsTargetHumidity: false,
    visualMinHumidity: 0,
    visualMaxHumidity: 0,
    temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_CELSIUS,
    visualCurrentTemperatureStep: 0.1,
    ...overrides,
});

/**
 * Builds the real ClimateComponent (real enum range checks, capability gating,
 * missing_state suppression, command gating — esphome-ts dist climate code)
 * over a state subject and a recording CommandInterface. Commands are asserted
 * on the wire bytes the queue emits.
 */
const createClimateComponent = (overrides: Partial<ClimateEntity> = {}) => {
    const entity = baseEntity(overrides);
    const commands: { type: MessageTypes; data: Uint8Array }[] = [];
    const commandInterface: CommandInterface = {
        sendEspMessage: vi.fn((type: MessageTypes, data: Uint8Array) => {
            commands.push({ type, data });
        }),
    };
    const state = new Subject<ClimateStateEvent>();
    const component = new ClimateComponent(entity, state.asObservable(), commandInterface);
    return { component, entity, state, commands, commandInterface };
};

/**
 * Pushes a device state event onto the component's state stream. The emitted
 * event always carries the decoded shape the real library produces: ts-proto
 * decode initializes every field, so a live state$ never carries partial
 * events — fields omitted here default to their decode values.
 */
const pushState = (state: Subject<ClimateStateEvent>, event: Partial<ClimateStateEvent> = {}): ClimateStateEvent => {
    const decoded: ClimateStateEvent = {
        key: 1,
        mode: ClimateMode.CLIMATE_MODE_OFF,
        currentTemperature: 0,
        targetTemperature: 0,
        targetTemperatureLow: 0,
        targetTemperatureHigh: 0,
        unusedLegacyAway: false,
        action: ClimateAction.CLIMATE_ACTION_OFF,
        fanMode: ClimateFanMode.CLIMATE_FAN_ON,
        swingMode: ClimateSwingMode.CLIMATE_SWING_OFF,
        customFanMode: '',
        preset: ClimatePreset.CLIMATE_PRESET_NONE,
        customPreset: '',
        currentHumidity: 0,
        targetHumidity: 0,
        missingState: false,
        ...event,
    };
    state.next(decoded);
    return decoded;
};

/**
 * Independent minimal proto reader for ClimateCommandRequest frames: maps each
 * wire field number to its varint value and its fixed32 value (bit-cast to
 * float for the float fields). Written against the wire format in
 * esphome-ts api.proto rather than the library's encoder, so command
 * assertions do not lean on the code under test's own serialization.
 */
interface WireField {
    varint?: number;
    float?: number;
}

const decodeCommand = (data: Uint8Array): Map<number, WireField> => {
    const fields = new Map<number, WireField>();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset < data.byteLength) {
        let tag = 0;
        let shift = 0;
        // varint tag
        for (;;) {
            ok(offset < data.byteLength, 'truncated tag');
            const byte = data[offset++];
            tag |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                break;
            }
            shift += 7;
        }
        const field = tag >>> 3;
        const wireType = tag & 0x7;
        if (wireType === 0) {
            let value = 0;
            let valueShift = 0;
            for (;;) {
                ok(offset < data.byteLength, 'truncated varint');
                const byte = data[offset++];
                value |= (byte & 0x7f) << valueShift;
                if ((byte & 0x80) === 0) {
                    break;
                }
                valueShift += 7;
            }
            fields.set(field, { ...(fields.get(field) ?? {}), varint: value });
        } else if (wireType === 5) {
            ok(offset + 4 <= data.byteLength, 'truncated fixed32');
            const word = view.getUint32(offset, true);
            offset += 4;
            fields.set(field, { ...(fields.get(field) ?? {}), varint: word, float: view.getFloat32(offset - 4, true) });
        } else {
            throw new Error(`unsupported wire type ${wireType}`);
        }
    }
    return fields;
};

const expectCommand = (commands: { type: MessageTypes; data: Uint8Array }[], index = 0) => {
    ok(commands.length > index, `expected command ${index}`);
    const command = commands[index];
    expect(command.type).toBe(MessageTypes.ClimateCommandRequest);
    expect(command.data.byteLength).toBeGreaterThan(0);
    return decodeCommand(command.data);
};

/**
 * Enum field value: proto3 encoders (and firmware decoders) treat an absent
 * field as its zero value — the real encoder omits zero-valued enums
 * (esphome-ts dist ClimateCommandRequest.encode: `if (message.mode !== 0)`),
 * so absence reads back as the first enum member.
 */
const enumField = (fields: Map<number, WireField>, field: number): number => fields.get(field)?.varint ?? 0;

/** Float32 wire values carry encoding rounding; compare with a tolerance that covers the float32 precision at any plausible temperature magnitude. */
const expectFloat = (field: WireField | undefined, value: number): void => {
    ok(field !== undefined, 'expected the field on the wire');
    expect(field.float).toBeCloseTo(value, 3);
};

/**
 * Invokes the stored onSet handler directly. This bypasses real hap's setValue
 * (which would swallow the handler's rejection) and also its validateUserInput
 * coercion — a raw `true` or string never reaches a production onSet, so the
 * non-number guard tests below exercise the plugin's own defense in isolation.
 */
const invokeSet = async (value: CharacteristicValue, characteristic: FakeHapCharacteristic): Promise<unknown> => {
    const handler = characteristic.setHandler;
    ok(handler, 'expected an onSet handler to be registered');
    return await handler(value);
};

const characteristicOf = (
    accessory: PlatformAccessory,
    constructor: FakeHapCharacteristicConstructor,
    serviceIndex = 0,
): FakeHapCharacteristic => {
    const service = accessory.services[serviceIndex] as unknown as FakeHapService;
    return assertCharacteristic(service, constructor);
};

const fanCharacteristicOf = (accessory: PlatformAccessory, constructor: FakeHapCharacteristicConstructor) =>
    characteristicOf(accessory, constructor, 1);

describe('climateHelper', () => {
    it('returns undefined for a component failing the instanceof ClimateComponent guard without touching the accessory', () => {
        const impostor = { name: 'impostor' } as unknown as BaseComponent;
        const { accessory, context } = createFakeAccessory();

        expect(climateHelper(impostor, accessory, createFakeApi())).toBeUndefined();
        expect(context.services).toHaveLength(0);
    });

    it('returns a teardown function that stops state pushes', () => {
        const { component, state } = createClimateComponent();
        const { accessory } = createFakeAccessory();

        const teardown = climateHelper(component, accessory, createFakeApi());
        expect(teardown).toBeTypeOf('function');

        const currentTemperature = characteristicOf(accessory, CURRENT_TEMPERATURE);
        pushState(state, { currentTemperature: 21 });
        expect(currentTemperature.value).toBe(21);

        teardown?.();
        pushState(state, { currentTemperature: 22 });
        expect(currentTemperature.value).toBe(21);
    });

    it('adds a Thermostat service with the component name and reuses an existing one', () => {
        const { component } = createClimateComponent();
        const { accessory, context } = createFakeAccessory();
        climateHelper(component, accessory, createFakeApi());
        const spy = vi.spyOn(accessory, 'addService');

        climateHelper(component, accessory, createFakeApi());

        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'thermostat-service-uuid');
        expect(context.services[0]).toHaveProperty('name', 'TestClimate');
        expect(spy).not.toHaveBeenCalled();
    });

    it('adds no fan service for a device without fan modes or swing', () => {
        const { component } = createClimateComponent();
        const { accessory, context } = createFakeAccessory();

        climateHelper(component, accessory, createFakeApi());

        expect(context.services).toHaveLength(1);
        expect(context.services[0].UUID).toBe('thermostat-service-uuid');
    });

    describe('TargetHeatingCoolingState', () => {
        it('constrains validValues to the HAP values of the advertised modes', () => {
            const heatOnly = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_OFF, ClimateMode.CLIMATE_MODE_HEAT],
            });
            const { accessory: heatAccessory } = createFakeAccessory();
            climateHelper(heatOnly.component, heatAccessory, createFakeApi());
            expect(characteristicOf(heatAccessory, TARGET_HEATING_COOLING).props).toEqual({ validValues: [0, 1] });

            // A dry-only device drives the COOL slot with its single mode.
            const dryOnly = createClimateComponent({ supportedModes: [ClimateMode.CLIMATE_MODE_DRY] });
            const { accessory: dryAccessory } = createFakeAccessory();
            climateHelper(dryOnly.component, dryAccessory, createFakeApi());
            expect(characteristicOf(dryAccessory, TARGET_HEATING_COOLING).props).toEqual({ validValues: [2] });
        });

        it('keeps the HAP class defaults when the device advertises no modes', () => {
            const { component } = createClimateComponent({ supportedModes: [] });
            const { accessory } = createFakeAccessory();

            climateHelper(component, accessory, createFakeApi());

            expect(characteristicOf(accessory, TARGET_HEATING_COOLING).props).toEqual({});
        });

        it('maps each ESPHome mode onto its HAP value on push, and OFF before the first state', async () => {
            const { component, state } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);
            const current = characteristicOf(accessory, CURRENT_HEATING_COOLING);

            const getHandler = target.getHandler;
            ok(getHandler, 'expected the TargetHeatingCoolingState onGet handler to be registered');
            expect(await getHandler()).toBe(TARGET_HEATING_COOLING.OFF);

            const cases: [ClimateMode, number][] = [
                [ClimateMode.CLIMATE_MODE_OFF, 0],
                [ClimateMode.CLIMATE_MODE_HEAT, 1],
                [ClimateMode.CLIMATE_MODE_COOL, 2],
                [ClimateMode.CLIMATE_MODE_HEAT_COOL, 3],
                [ClimateMode.CLIMATE_MODE_AUTO, 3],
            ];
            for (const [mode, expected] of cases) {
                // Reset through OFF first so a dropped push cannot hide behind
                // the previous case's value (HEAT_COOL and AUTO both map to 3).
                pushState(state, { mode: ClimateMode.CLIMATE_MODE_OFF, action: ClimateAction.CLIMATE_ACTION_IDLE });
                expect(target.value, `mode ${mode} reset`).toBe(0);
                pushState(state, { mode, action: ClimateAction.CLIMATE_ACTION_IDLE });
                expect(target.value, `mode ${mode}`).toBe(expected);
            }
            // The current-state row rides the same pushes.
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, action: ClimateAction.CLIMATE_ACTION_HEATING });
            expect(current.value).toBe(CURRENT_HEATING_COOLING.HEAT);
        });

        it('maps a dry-only device onto the COOL slot', () => {
            const { component, state } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_DRY],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_DRY, action: ClimateAction.CLIMATE_ACTION_DRYING });

            expect(target.value).toBe(TARGET_HEATING_COOLING.COOL);
        });

        it('maps a fan-only device onto the COOL slot', () => {
            const { component, state } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_FAN_ONLY],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_FAN_ONLY, action: ClimateAction.CLIMATE_ACTION_FAN });

            expect(target.value).toBe(TARGET_HEATING_COOLING.COOL);
        });

        it('sends the mapped mode command, preferring HEAT_COOL for AUTO like HA', async () => {
            const { component, commands } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            await invokeSet(TARGET_HEATING_COOLING.HEAT, target);
            let fields = expectCommand(commands, 0);
            expect(fields.get(2)?.varint).toBe(1); // hasMode
            expect(enumField(fields, 3)).toBe(ClimateMode.CLIMATE_MODE_HEAT);

            await invokeSet(TARGET_HEATING_COOLING.AUTO, target);
            fields = expectCommand(commands, 1);
            expect(fields.get(3)?.varint).toBe(ClimateMode.CLIMATE_MODE_HEAT_COOL);

            await invokeSet(TARGET_HEATING_COOLING.OFF, target);
            fields = expectCommand(commands, 2);
            // The encoder omits zero-valued enums (proto3), so the OFF mode
            // travels as hasMode alone — assert the has-flag that carries it.
            expect(fields.get(2)?.varint).toBe(1);
            expect(enumField(fields, 3)).toBe(ClimateMode.CLIMATE_MODE_OFF);
            expect(commands).toHaveLength(3);
        });

        it('drives the COOL slot with DRY or FAN_ONLY when the device has no COOL', async () => {
            const { component, commands } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_OFF, ClimateMode.CLIMATE_MODE_FAN_ONLY],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            await invokeSet(TARGET_HEATING_COOLING.COOL, target);

            const fields = expectCommand(commands);
            expect(enumField(fields, 3)).toBe(ClimateMode.CLIMATE_MODE_FAN_ONLY);
        });

        it('ignores non-number writes without a command', async () => {
            const { component, commands } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            await invokeSet(
                true as unknown as CharacteristicValue,
                characteristicOf(accessory, TARGET_HEATING_COOLING),
            );

            expect(commands).toHaveLength(0);
        });

        it('pushes the shared HAP slot for a slot-sharing mode, like HA (COOL+DRY device in DRY)', () => {
            const { component, state } = createClimateComponent({
                supportedModes: [
                    ClimateMode.CLIMATE_MODE_OFF,
                    ClimateMode.CLIMATE_MODE_COOL,
                    ClimateMode.CLIMATE_MODE_DRY,
                ],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_OFF });
            expect(target.value).toBe(TARGET_HEATING_COOLING.OFF);

            // DRY maps onto the COOL slot; HA pushes that slot whenever it has
            // any backing mode (type_thermostats.py async_update_state), so the
            // tile reflects the device's dry state through the COOL slot.
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_DRY, action: ClimateAction.CLIMATE_ACTION_DRYING });
            expect(target.value).toBe(TARGET_HEATING_COOLING.COOL);
        });

        it('does not push a mode mapping onto no advertised slot (HA "Cannot map hvac target mode")', () => {
            const { component, state } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_OFF, ClimateMode.CLIMATE_MODE_HEAT],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_OFF });
            expect(target.value).toBe(TARGET_HEATING_COOLING.OFF);

            // Firmware reporting a mode outside its own advertised list maps
            // onto the COOL slot, which the characteristic's validValues [0, 1]
            // do not contain — the push is dropped.
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_COOL });
            expect(target.value).toBe(TARGET_HEATING_COOLING.OFF);
        });

        it('serves the first advertised value before the first state, not the OFF default', async () => {
            const { component } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_DRY],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            const getHandler = target.getHandler;
            ok(getHandler, 'expected the TargetHeatingCoolingState onGet handler to be registered');
            // OFF would sit outside validValues [2] and trip hap's
            // validateUserInput revert on every GET; the first advertised
            // value matches hap's own getDefaultValue semantics.
            expect(await getHandler()).toBe(TARGET_HEATING_COOLING.COOL);
        });

        it('commands the newer AUTO value on a device that advertises AUTO but not HEAT_COOL', async () => {
            const { component, commands } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_OFF, ClimateMode.CLIMATE_MODE_AUTO],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_HEATING_COOLING);

            expect(characteristicOf(accessory, TARGET_HEATING_COOLING).props).toEqual({ validValues: [0, 3] });
            await invokeSet(TARGET_HEATING_COOLING.AUTO, target);

            expect(enumField(expectCommand(commands), 3)).toBe(ClimateMode.CLIMATE_MODE_AUTO);
        });

        it('prefers DRY over FAN_ONLY for the COOL slot on a device advertising both', async () => {
            const { component, commands } = createClimateComponent({
                supportedModes: [ClimateMode.CLIMATE_MODE_DRY, ClimateMode.CLIMATE_MODE_FAN_ONLY],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            await invokeSet(TARGET_HEATING_COOLING.COOL, characteristicOf(accessory, TARGET_HEATING_COOLING));

            // HA's reverse dict would keep FAN_ONLY by last-wins accident; the
            // plugin deliberately commands DRY as the mode closer to cooling.
            expect(enumField(expectCommand(commands), 3)).toBe(ClimateMode.CLIMATE_MODE_DRY);
        });

        it('serves the commanded mode on read before the echo, and re-syncs when the device refuses it', async () => {
            const { component, state } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const targetMode = characteristicOf(accessory, TARGET_HEATING_COOLING);
            const getHandler = targetMode.getHandler;
            ok(getHandler, 'expected the TargetHeatingCoolingState onGet handler to be registered');

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT });
            await invokeSet(TARGET_HEATING_COOLING.COOL, targetMode);
            expect(await getHandler()).toBe(TARGET_HEATING_COOLING.COOL); // commanded, echo pending

            // The device echoes its actual (unchanged) mode: the read follows.
            // (The echo carries a changed temperature too — esphome-ts v5
            // shallow-compare dedup drops a byte-identical re-sent state.)
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, currentTemperature: 21 });
            expect(await getHandler()).toBe(TARGET_HEATING_COOLING.HEAT);
        });

        it('throws a HapStatusError with SERVICE_COMMUNICATION_FAILURE when the command write fails', async () => {
            const { component } = createClimateComponent();
            // The real command pipeline routes through rxjs, where a transport
            // throw does not propagate back through setMode — so the seam under
            // test is the binding's wrap around a throwing apply, faked at the
            // component method boundary.
            vi.spyOn(component, 'setMode').mockImplementation(() => {
                throw new Error('device gone');
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            const setHandler = characteristicOf(accessory, TARGET_HEATING_COOLING).setHandler;
            ok(setHandler, 'expected the TargetHeatingCoolingState onSet handler to be registered');
            await expect(setHandler(TARGET_HEATING_COOLING.HEAT)).rejects.toThrow(FakeHapStatusError);
            await expect(setHandler(TARGET_HEATING_COOLING.HEAT)).rejects.toMatchObject({
                hapStatus: 'SERVICE_COMMUNICATION_FAILURE',
            });
        });
    });

    describe('CurrentHeatingCoolingState', () => {
        it('maps the climate action live and on push', async () => {
            const { component, state } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const current = characteristicOf(accessory, CURRENT_HEATING_COOLING);

            const cases: [ClimateAction, number][] = [
                [ClimateAction.CLIMATE_ACTION_OFF, 0],
                [ClimateAction.CLIMATE_ACTION_IDLE, 0],
                [ClimateAction.CLIMATE_ACTION_HEATING, 1],
                [ClimateAction.CLIMATE_ACTION_DEFROSTING, 1],
                [ClimateAction.CLIMATE_ACTION_COOLING, 2],
                [ClimateAction.CLIMATE_ACTION_DRYING, 2],
                [ClimateAction.CLIMATE_ACTION_FAN, 2],
            ];
            for (const [action, expected] of cases) {
                pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, action });
                expect(current.value, `action ${action}`).toBe(expected);
                const getHandler = current.getHandler;
                ok(getHandler, 'expected the CurrentHeatingCoolingState onGet handler to be registered');
                expect(await getHandler()).toBe(expected);
            }
        });

        it('stays unwired when the device does not support action reporting', () => {
            const { component } = createClimateComponent({ supportsAction: false });
            const { accessory } = createFakeAccessory();

            climateHelper(component, accessory, createFakeApi());

            const current = characteristicOf(accessory, CURRENT_HEATING_COOLING);
            expect(current.getHandler).toBeUndefined();
            expect(current.setHandler).toBeUndefined();
        });

        it('does not push an OFF claim for a missing_state frame', () => {
            const { component, state } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const current = characteristicOf(accessory, CURRENT_HEATING_COOLING);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, action: ClimateAction.CLIMATE_ACTION_HEATING });
            expect(current.value).toBe(CURRENT_HEATING_COOLING.HEAT);

            pushState(state, { missingState: true });
            expect(current.value).toBe(CURRENT_HEATING_COOLING.HEAT);
        });
    });

    describe('temperatures', () => {
        it('projects the current temperature, and a missing_state frame keeps the last reading', () => {
            const { component, state } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const currentTemperature = characteristicOf(accessory, CURRENT_TEMPERATURE);

            pushState(state, { currentTemperature: 21.5 });
            expect(currentTemperature.value).toBe(21.5);

            pushState(state, { missingState: true, currentTemperature: 0 });
            expect(currentTemperature.value).toBe(21.5);
        });

        it('converts Fahrenheit device values to Celsius', () => {
            const { component, state } = createClimateComponent({
                temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_FAHRENHEIT,
                visualMinTemperature: 50,
                visualMaxTemperature: 86,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const currentTemperature = characteristicOf(accessory, CURRENT_TEMPERATURE);

            pushState(state, { currentTemperature: 72 });
            // The plugin pushes (72-32)·5/9 = 22.2222…; real hap quantizes the
            // stored value to the characteristic's 0.1 step and serves 22.2 —
            // the fake does not model that (see hapFakes.ts divergences), so
            // the assertion pins the conversion, tolerant of both readings.
            expect(currentTemperature.value).toBeCloseTo(22.2, 1);
        });

        it('converts Kelvin device values to Celsius', () => {
            const { component, state } = createClimateComponent({
                temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_KELVIN,
                visualMinTemperature: 280.15,
                visualMaxTemperature: 303.15,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const currentTemperature = characteristicOf(accessory, CURRENT_TEMPERATURE);

            pushState(state, { currentTemperature: 295.15 });
            expect(currentTemperature.value).toBeCloseTo(22, 5);
            // The visual range converts too: 280.15 K and 303.15 K are 7..30 °C.
            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({ minValue: 7, maxValue: 30 });
        });

        it('applies the visual range as HAP bounds, rounded inward and clamped to zero', () => {
            const { component } = createClimateComponent({ visualMinTemperature: 7.03, visualMaxTemperature: 29.97 });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({ minValue: 7.1, maxValue: 29.9 });

            const negative = createClimateComponent({ visualMinTemperature: -5, visualMaxTemperature: 20 });
            const { accessory: negativeAccessory } = createFakeAccessory();
            climateHelper(negative.component, negativeAccessory, createFakeApi());
            expect(characteristicOf(negativeAccessory, TARGET_TEMPERATURE).props).toEqual({
                minValue: 0,
                maxValue: 20,
            });
        });

        it('order-corrects a reversed visual range, like HA (climate_util get_temperature_range_from_state)', () => {
            const { component } = createClimateComponent({ visualMinTemperature: 30, visualMaxTemperature: 7 });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({ minValue: 7, maxValue: 30 });
        });

        it('keeps the exact limits when the range is too narrow to hold a 0.1 step', () => {
            const { component } = createClimateComponent({ visualMinTemperature: 7.04, visualMaxTemperature: 7.06 });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            // Inward rounding would invert (7.1 > 7.0); the exact limits stay,
            // like HA's `if rounded_min <= rounded_max` guard.
            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({ minValue: 7.04, maxValue: 7.06 });
        });

        it('falls back to the HAP class bounds for an all-negative advertised range', () => {
            const { component } = createClimateComponent({ visualMinTemperature: -30, visualMaxTemperature: -18 });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            // The ≥0 clamp collapses the range; a HomeKit slider cannot reach
            // below-zero setpoints either way, so the class defaults stay.
            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({});
        });

        it('converts a Fahrenheit visual range to Celsius bounds', () => {
            const { component } = createClimateComponent({
                temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_FAHRENHEIT,
                visualMinTemperature: 50,
                visualMaxTemperature: 86,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({ minValue: 10, maxValue: 30 });
        });

        it('keeps the HAP class bounds when the advertised range is degenerate', () => {
            const { component } = createClimateComponent({ visualMinTemperature: 0, visualMaxTemperature: 0 });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            expect(characteristicOf(accessory, TARGET_TEMPERATURE).props).toEqual({});
        });

        it('sends the single setpoint on a target write, converted to the device unit', async () => {
            const fahrenheit = createClimateComponent({
                temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_FAHRENHEIT,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(fahrenheit.component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_TEMPERATURE);

            await invokeSet(21, target);
            let fields = expectCommand(fahrenheit.commands);
            expect(fields.get(4)?.varint).toBe(1); // hasTargetTemperature
            expectFloat(fields.get(5), 69.8); // 21°C in °F

            const celsius = createClimateComponent();
            const { accessory: celsiusAccessory } = createFakeAccessory();
            climateHelper(celsius.component, celsiusAccessory, createFakeApi());
            await invokeSet(21, characteristicOf(celsiusAccessory, TARGET_TEMPERATURE));
            fields = expectCommand(celsius.commands);
            expectFloat(fields.get(5), 21);
        });

        it('converts a Kelvin target write to the device unit', async () => {
            const kelvin = createClimateComponent({ temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_KELVIN });
            const { accessory } = createFakeAccessory();
            climateHelper(kelvin.component, accessory, createFakeApi());

            await invokeSet(21, characteristicOf(accessory, TARGET_TEMPERATURE));

            const fields = expectCommand(kelvin.commands);
            expect(fields.get(4)?.varint).toBe(1); // hasTargetTemperature
            expectFloat(fields.get(5), 294.15); // 21°C in K
        });

        it('wires no read handler on the value characteristics (hap serves stored values)', () => {
            const { component } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            // No onGet on purpose (sensor.ts pattern): a device without a
            // measurement serves the HAP default, and a missing_state frame
            // must not overwrite the last real reading.
            expect(characteristicOf(accessory, CURRENT_TEMPERATURE).getHandler).toBeUndefined();
            expect(characteristicOf(accessory, TARGET_TEMPERATURE).getHandler).toBeUndefined();
            const humidity = createClimateComponent({ supportsCurrentHumidity: true });
            const { accessory: humidityAccessory } = createFakeAccessory();
            climateHelper(humidity.component, humidityAccessory, createFakeApi());
            expect(characteristicOf(humidityAccessory, CURRENT_HUMIDITY).getHandler).toBeUndefined();
        });

        it('pushes the single setpoint from device states', () => {
            const { component, state } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const target = characteristicOf(accessory, TARGET_TEMPERATURE);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, targetTemperature: 19.5 });
            expect(target.value).toBe(19.5);
        });

        it('does not send a command when the write is not a number', async () => {
            const { component, commands } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            await invokeSet('warm' as unknown as CharacteristicValue, characteristicOf(accessory, TARGET_TEMPERATURE));

            expect(commands).toHaveLength(0);
        });
    });

    describe('two-point devices', () => {
        const setupTwoPoint = (overrides: Partial<ClimateEntity> = {}) => {
            const climate = createClimateComponent({
                supportsTwoPointTargetTemperature: true,
                ...overrides,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(climate.component, accessory, createFakeApi());
            return {
                ...climate,
                accessory,
                cooling: characteristicOf(accessory, COOLING_THRESHOLD),
                heating: characteristicOf(accessory, HEATING_THRESHOLD),
                target: characteristicOf(accessory, TARGET_TEMPERATURE),
            };
        };

        it('wires no threshold characteristics on a single-setpoint device', () => {
            const { component } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const service = accessory.services[0] as unknown as FakeHapService;

            expect(service.testCharacteristic(COOLING_THRESHOLD)).toBe(false);
            expect(service.testCharacteristic(HEATING_THRESHOLD)).toBe(false);
        });

        it('auto-adds only characteristics real hap lists as optional for Thermostat', () => {
            const { component } = createClimateComponent({
                supportsTwoPointTargetTemperature: true,
                supportsCurrentHumidity: true,
                supportsTargetHumidity: true,
            });
            const existingService = new ThermostatService('TestClimate');
            // Real hap Service.Thermostat lists the humidity and threshold
            // characteristics among its optional characteristics
            // (ServiceDefinitions.js:1184-1187).
            existingService.optionalCharacteristics = [
                CURRENT_HUMIDITY,
                TARGET_HUMIDITY,
                COOLING_THRESHOLD,
                HEATING_THRESHOLD,
            ];
            const { accessory } = createFakeAccessory(existingService);

            climateHelper(component, accessory, createFakeApi());

            const service = accessory.services[0] as unknown as FakeHapService;
            expect(service.autoAddedUnlistedCharacteristics).toHaveLength(0);
            expect(service.testCharacteristic(COOLING_THRESHOLD)).toBe(true);
            expect(service.testCharacteristic(HEATING_THRESHOLD)).toBe(true);
            expect(service.testCharacteristic(CURRENT_HUMIDITY)).toBe(true);
            expect(service.testCharacteristic(TARGET_HUMIDITY)).toBe(true);
        });

        it('serves the low bound while heating and the high bound while cooling on TargetTemperature', () => {
            const { state, target } = setupTwoPoint();

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            expect(target.value).toBe(19);
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            expect(target.value).toBe(24);
            // In heat/cool mode HomeKit renders the threshold pair; no single target exists.
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            expect(target.value).toBe(24); // keeps the last single-setpoint view
        });

        it('routes a bare target write to the bound of the current mode', async () => {
            const { state, commands, target } = setupTwoPoint();

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            await invokeSet(21, target);
            let fields = expectCommand(commands);
            expect(fields.get(6)?.varint).toBe(1); // hasTargetTemperatureLow
            expectFloat(fields.get(7), 21);
            expect(fields.get(8)).toBeUndefined(); // no high side in the command

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            await invokeSet(25, target);
            fields = expectCommand(commands, 1);
            expect(fields.get(8)?.varint).toBe(1); // hasTargetTemperatureHigh
            expectFloat(fields.get(9), 25);
            expect(fields.get(6)).toBeUndefined();

            // In heat/cool mode HomeKit writes the threshold pair instead; the
            // bare write is dropped like HA drops it.
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            await invokeSet(22, target);
            expect(commands).toHaveLength(2);
        });

        it('routes a batched mode-and-temperature write by the commanded mode, not the stale echo', async () => {
            const { state, commands, accessory, target } = setupTwoPoint();
            const targetMode = characteristicOf(accessory, TARGET_HEATING_COOLING);

            // Siri batches the mode change and the setpoint into one request;
            // the device has echoed HEAT and not yet confirmed the new mode.
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            await invokeSet(TARGET_HEATING_COOLING.COOL, targetMode);
            await invokeSet(25, target);

            const fields = expectCommand(commands, 1);
            expect(fields.get(8)?.varint).toBe(1); // routed to the high bound
            expectFloat(fields.get(9), 25);

            // Once the echo confirms, routing follows the device again.
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 25,
            });
            await invokeSet(26, target);
            expectFloat(expectCommand(commands, 2).get(9), 26);
        });

        it('pushes both thresholds from device states', () => {
            const { state, cooling, heating } = setupTwoPoint();

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });

            expect(heating.value).toBe(19);
            expect(cooling.value).toBe(24);
        });

        it('sends both bounds in one command, filling the unchanged side from the live state', async () => {
            const { state, commands, cooling } = setupTwoPoint();

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            await invokeSet(26, cooling);

            const fields = expectCommand(commands);
            expect(fields.get(6)?.varint).toBe(1); // hasTargetTemperatureLow
            expectFloat(fields.get(7), 19);
            expect(fields.get(8)?.varint).toBe(1); // hasTargetTemperatureHigh
            expectFloat(fields.get(9), 26);
        });

        it('collapses the unchanged side when the write would invert the range', async () => {
            const { state, commands, cooling, heating } = setupTwoPoint();

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
            });
            await invokeSet(15, cooling); // below the live low: low collapses onto 15
            let fields = expectCommand(commands);
            expectFloat(fields.get(7), 15);
            expectFloat(fields.get(9), 15);

            await invokeSet(28, heating); // above the live high: high collapses onto 28
            fields = expectCommand(commands, 1);
            expectFloat(fields.get(7), 28);
            expectFloat(fields.get(9), 28);
        });

        it('falls back to the moved bound alone when no state arrived yet', async () => {
            const { commands, cooling } = setupTwoPoint();

            await invokeSet(24, cooling);

            const fields = expectCommand(commands);
            expectFloat(fields.get(7), 24);
            expectFloat(fields.get(9), 24);
        });

        it('converts a Fahrenheit threshold write through the device unit on both bounds', async () => {
            const climate = createClimateComponent({
                supportsTwoPointTargetTemperature: true,
                temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_FAHRENHEIT,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(climate.component, accessory, createFakeApi());
            const cooling = characteristicOf(accessory, COOLING_THRESHOLD);

            pushState(climate.state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                targetTemperatureLow: 66.2, // 19 °C
                targetTemperatureHigh: 75.2, // 24 °C
            });
            await invokeSet(25, cooling); // 25 °C in HAP space

            // The moved bound converts to °F; the unchanged side keeps its live
            // device-unit value, and both travel in one command.
            const fields = expectCommand(climate.commands);
            expectFloat(fields.get(7), 66.2); // live low, untouched
            expectFloat(fields.get(9), 77); // 25 °C → 77 °F
        });
    });

    describe('TemperatureDisplayUnits', () => {
        it('reads Celsius for Celsius and Kelvin devices, Fahrenheit for Fahrenheit devices', async () => {
            const celsius = createClimateComponent();
            const { accessory: celsiusAccessory } = createFakeAccessory();
            climateHelper(celsius.component, celsiusAccessory, createFakeApi());
            const celsiusUnits = characteristicOf(celsiusAccessory, TEMPERATURE_DISPLAY_UNITS);
            const celsiusHandler = celsiusUnits.getHandler;
            ok(celsiusHandler, 'expected the TemperatureDisplayUnits onGet handler to be registered');
            expect(await celsiusHandler()).toBe(TEMPERATURE_DISPLAY_UNITS.CELSIUS);

            const fahrenheit = createClimateComponent({
                temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_FAHRENHEIT,
            });
            const { accessory: fahrenheitAccessory } = createFakeAccessory();
            climateHelper(fahrenheit.component, fahrenheitAccessory, createFakeApi());
            const fahrenheitHandler = characteristicOf(fahrenheitAccessory, TEMPERATURE_DISPLAY_UNITS).getHandler;
            ok(fahrenheitHandler, 'expected the TemperatureDisplayUnits onGet handler to be registered');
            expect(await fahrenheitHandler()).toBe(TEMPERATURE_DISPLAY_UNITS.FAHRENHEIT);

            const kelvin = createClimateComponent({ temperatureUnit: TemperatureUnit.TEMPERATURE_UNIT_KELVIN });
            const { accessory: kelvinAccessory } = createFakeAccessory();
            climateHelper(kelvin.component, kelvinAccessory, createFakeApi());
            const kelvinHandler = characteristicOf(kelvinAccessory, TEMPERATURE_DISPLAY_UNITS).getHandler;
            ok(kelvinHandler, 'expected the TemperatureDisplayUnits onGet handler to be registered');
            expect(await kelvinHandler()).toBe(TEMPERATURE_DISPLAY_UNITS.CELSIUS);
        });
    });

    describe('humidity', () => {
        const setupHumidity = () => {
            const climate = createClimateComponent({
                supportsCurrentHumidity: true,
                supportsTargetHumidity: true,
                visualMinHumidity: 30,
                visualMaxHumidity: 80,
            });
            const { accessory } = createFakeAccessory();
            climateHelper(climate.component, accessory, createFakeApi());
            return {
                ...climate,
                accessory,
                current: characteristicOf(accessory, CURRENT_HUMIDITY),
                target: characteristicOf(accessory, TARGET_HUMIDITY),
            };
        };

        it('projects current humidity and sends target humidity writes', async () => {
            const { state, commands, current, target } = setupHumidity();

            pushState(state, { currentHumidity: 55, targetHumidity: 60 });
            expect(current.value).toBe(55);
            expect(target.value).toBe(60);

            await invokeSet(65, target);
            const fields = expectCommand(commands);
            expect(fields.get(22)?.varint).toBe(1); // hasTargetHumidity
            expectFloat(fields.get(23), 65);
        });

        it('applies only the advertised minimum as bound, like HA', () => {
            const { target } = setupHumidity();

            expect(target.props).toEqual({ minValue: 30 });
        });

        it('wires no humidity characteristics when the device has none', () => {
            const { component } = createClimateComponent();
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());
            const service = accessory.services[0] as unknown as FakeHapService;

            expect(service.testCharacteristic(CURRENT_HUMIDITY)).toBe(false);
            expect(service.testCharacteristic(TARGET_HUMIDITY)).toBe(false);
        });

        it('keeps the HAP humidity bounds when the device advertises no usable minimum', () => {
            const climate = createClimateComponent({ supportsTargetHumidity: true, visualMinHumidity: 0 });
            const { accessory } = createFakeAccessory();
            climateHelper(climate.component, accessory, createFakeApi());

            expect(characteristicOf(accessory, TARGET_HUMIDITY).props).toEqual({});
        });
    });

    describe('linked fan service', () => {
        const setupFan = (overrides: Partial<ClimateEntity> = {}) => {
            const climate = createClimateComponent({
                supportedFanModes: [
                    ClimateFanMode.CLIMATE_FAN_OFF,
                    ClimateFanMode.CLIMATE_FAN_ON,
                    ClimateFanMode.CLIMATE_FAN_AUTO,
                    ClimateFanMode.CLIMATE_FAN_LOW,
                    ClimateFanMode.CLIMATE_FAN_MEDIUM,
                    ClimateFanMode.CLIMATE_FAN_HIGH,
                ],
                supportedSwingModes: [
                    ClimateSwingMode.CLIMATE_SWING_OFF,
                    ClimateSwingMode.CLIMATE_SWING_BOTH,
                    ClimateSwingMode.CLIMATE_SWING_VERTICAL,
                ],
                ...overrides,
            });
            const { accessory, context } = createFakeAccessory();
            climateHelper(climate.component, accessory, createFakeApi());
            return { ...climate, accessory, context };
        };

        it('adds a Fanv2 service linked onto the Thermostat service', () => {
            const { context } = setupFan();

            expect(context.services).toHaveLength(2);
            expect(context.services[1].UUID).toBe('fanv2-service-uuid');
            const thermostat = context.services[0] as unknown as FakeHapService;
            const fan = context.services[1] as unknown as FakeHapService;
            expect(thermostat.linkedServices).toEqual([fan]);
        });

        it('maps RotationSpeed steps to the ordered speeds, HA style', async () => {
            const { commands, accessory } = setupFan();
            const rotationSpeed = fanCharacteristicOf(accessory, ROTATION_SPEED);
            expect(rotationSpeed.props).toEqual({ minStep: 100 / 3 });

            await invokeSet(100, rotationSpeed);
            let fields = expectCommand(commands);
            expect(fields.get(12)?.varint).toBe(1); // hasFanMode
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_HIGH);

            await invokeSet(34, rotationSpeed); // lowest step → LOW
            fields = expectCommand(commands, 1);
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_LOW);

            await invokeSet(67, rotationSpeed); // middle step → MEDIUM
            fields = expectCommand(commands, 2);
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_MEDIUM);

            // A slider-off write commands nothing (HA drops speed 0 too).
            await invokeSet(0, rotationSpeed);
            expect(commands).toHaveLength(3);
        });

        it('orders MIDDLE before MEDIUM like HA (ORDERED_FAN_SPEEDS)', async () => {
            const { commands, accessory } = setupFan({
                supportedFanModes: [
                    ClimateFanMode.CLIMATE_FAN_OFF,
                    ClimateFanMode.CLIMATE_FAN_LOW,
                    ClimateFanMode.CLIMATE_FAN_MIDDLE,
                    ClimateFanMode.CLIMATE_FAN_MEDIUM,
                    ClimateFanMode.CLIMATE_FAN_HIGH,
                ],
            });
            const rotationSpeed = fanCharacteristicOf(accessory, ROTATION_SPEED);
            expect(rotationSpeed.props).toEqual({ minStep: 25 });

            // 50% of [LOW, MIDDLE, MEDIUM, HIGH] is MIDDLE, not MEDIUM.
            await invokeSet(50, rotationSpeed);
            const fields = expectCommand(commands);
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_MIDDLE);
        });

        it('projects RotationSpeed from the reported fan mode and keeps it for non-speed modes', () => {
            const { state, accessory } = setupFan();
            const rotationSpeed = fanCharacteristicOf(accessory, ROTATION_SPEED);

            pushState(state, { fanMode: ClimateFanMode.CLIMATE_FAN_LOW });
            // The plugin pushes floor(1·100/3) = 33 like HA; real hap then
            // quantizes the stored value to the 33.33 minStep grid — the fake
            // does not model that (see hapFakes.ts divergences).
            expect(rotationSpeed.value).toBe(33);
            pushState(state, { fanMode: ClimateFanMode.CLIMATE_FAN_HIGH });
            expect(rotationSpeed.value).toBe(100);
            // AUTO has no slider position; the last one is kept.
            pushState(state, { fanMode: ClimateFanMode.CLIMATE_FAN_AUTO });
            expect(rotationSpeed.value).toBe(100);
        });

        it('toggles Active from the device state and commands OFF/medium writes', async () => {
            const { state, commands, accessory } = setupFan();
            const active = fanCharacteristicOf(accessory, ACTIVE);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, fanMode: ClimateFanMode.CLIMATE_FAN_LOW });
            expect(active.value).toBe(ACTIVE.ACTIVE);

            // A switched-off climate is never an active fan, whatever the fan mode.
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_OFF, fanMode: ClimateFanMode.CLIMATE_FAN_LOW });
            expect(active.value).toBe(ACTIVE.INACTIVE);

            // A custom fan mode also counts as active. The regular fan mode
            // carries its decode default ON here — the wire omits fan_mode
            // while a custom mode is active, and ts-proto decode initializes
            // the field — while the component getter still clears it.
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT,
                fanMode: ClimateFanMode.CLIMATE_FAN_ON,
                customFanMode: 'Nature',
            });
            expect(active.value).toBe(ACTIVE.ACTIVE);

            await invokeSet(ACTIVE.INACTIVE, active);
            let fields = expectCommand(commands);
            expect(fields.get(12)?.varint).toBe(1); // hasFanMode
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_OFF);

            // The on-mode is HA's 50% speed item (MEDIUM here), preferred over FAN_ON.
            await invokeSet(ACTIVE.ACTIVE, active);
            fields = expectCommand(commands, 1);
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_MEDIUM);
        });

        it('toggles TargetFanState between AUTO and the on-mode', async () => {
            const { state, commands, accessory } = setupFan();
            const targetFanState = fanCharacteristicOf(accessory, TARGET_FAN_STATE);

            await invokeSet(TARGET_FAN_STATE.AUTO, targetFanState);
            let fields = expectCommand(commands);
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_AUTO);

            await invokeSet(TARGET_FAN_STATE.MANUAL, targetFanState);
            fields = expectCommand(commands, 1);
            expect(fields.get(12)?.varint).toBe(1); // hasFanMode
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_MEDIUM);

            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, fanMode: ClimateFanMode.CLIMATE_FAN_AUTO });
            expect(targetFanState.value).toBe(TARGET_FAN_STATE.AUTO);
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, fanMode: ClimateFanMode.CLIMATE_FAN_ON });
            expect(targetFanState.value).toBe(TARGET_FAN_STATE.MANUAL);
        });

        it('selects the 50% speed item when the device has no FAN_ON', async () => {
            const { commands, accessory } = setupFan({
                supportedFanModes: [
                    ClimateFanMode.CLIMATE_FAN_AUTO,
                    ClimateFanMode.CLIMATE_FAN_LOW,
                    ClimateFanMode.CLIMATE_FAN_MEDIUM,
                    ClimateFanMode.CLIMATE_FAN_HIGH,
                ],
            });
            const targetFanState = fanCharacteristicOf(accessory, TARGET_FAN_STATE);

            await invokeSet(TARGET_FAN_STATE.MANUAL, targetFanState);

            const fields = expectCommand(commands);
            expect(enumField(fields, 13)).toBe(ClimateFanMode.CLIMATE_FAN_MEDIUM);
        });

        it('rejects the Active off write on a device without FAN_OFF, like HA flip-back', async () => {
            const { commands, accessory } = setupFan({
                supportedFanModes: [
                    ClimateFanMode.CLIMATE_FAN_AUTO,
                    ClimateFanMode.CLIMATE_FAN_LOW,
                    ClimateFanMode.CLIMATE_FAN_MEDIUM,
                ],
            });
            const active = fanCharacteristicOf(accessory, ACTIVE);

            // HA rejects the write and flips the toggle back
            // (_set_fan_active / _reject_char_write); the throw surfaces as a
            // HapStatusError, hap stores nothing, and no command is sent.
            await expect(invokeSet(ACTIVE.INACTIVE, active)).rejects.toThrow(FakeHapStatusError);
            await expect(invokeSet(ACTIVE.INACTIVE, active)).rejects.toMatchObject({
                hapStatus: 'SERVICE_COMMUNICATION_FAILURE',
            });
            expect(commands).toHaveLength(0);
        });

        it('maps the climate action onto CurrentFanState like HA', async () => {
            const { state, accessory } = setupFan();
            const currentFanState = fanCharacteristicOf(accessory, CURRENT_FAN_STATE);

            const cases: [ClimateAction, number][] = [
                [ClimateAction.CLIMATE_ACTION_OFF, CURRENT_FAN_STATE.INACTIVE],
                [ClimateAction.CLIMATE_ACTION_IDLE, CURRENT_FAN_STATE.IDLE],
                [ClimateAction.CLIMATE_ACTION_DEFROSTING, CURRENT_FAN_STATE.IDLE],
                [ClimateAction.CLIMATE_ACTION_HEATING, CURRENT_FAN_STATE.BLOWING_AIR],
                [ClimateAction.CLIMATE_ACTION_COOLING, CURRENT_FAN_STATE.BLOWING_AIR],
                [ClimateAction.CLIMATE_ACTION_DRYING, CURRENT_FAN_STATE.BLOWING_AIR],
                [ClimateAction.CLIMATE_ACTION_FAN, CURRENT_FAN_STATE.BLOWING_AIR],
            ];
            for (const [action, expected] of cases) {
                pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, action });
                expect(currentFanState.value, `action ${action}`).toBe(expected);
                const getHandler = currentFanState.getHandler;
                ok(getHandler, 'expected the CurrentFanState onGet handler to be registered');
                expect(await getHandler()).toBe(expected);
            }
        });

        it('commands the preferred swing mode and reports swing on/off', async () => {
            const { state, commands, accessory } = setupFan();
            const swingMode = fanCharacteristicOf(accessory, SWING_MODE);

            await invokeSet(SWING_MODE.SWING_ENABLED, swingMode);
            let fields = expectCommand(commands);
            expect(fields.get(14)?.varint).toBe(1); // hasSwingMode
            expect(enumField(fields, 15)).toBe(ClimateSwingMode.CLIMATE_SWING_BOTH); // preference order

            await invokeSet(SWING_MODE.SWING_DISABLED, swingMode);
            fields = expectCommand(commands, 1);
            // The encoder omits zero-valued enums (proto3), so swing-off
            // travels as hasSwingMode alone — assert the has-flag that carries it.
            expect(fields.get(14)?.varint).toBe(1);
            expect(enumField(fields, 15)).toBe(ClimateSwingMode.CLIMATE_SWING_OFF);

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT,
                swingMode: ClimateSwingMode.CLIMATE_SWING_VERTICAL,
            });
            expect(swingMode.value).toBe(SWING_MODE.SWING_ENABLED);
            pushState(state, { mode: ClimateMode.CLIMATE_MODE_HEAT, swingMode: ClimateSwingMode.CLIMATE_SWING_OFF });
            expect(swingMode.value).toBe(SWING_MODE.SWING_DISABLED);
        });

        it('adds no fan service when AUTO is the only fan mode (the device could never leave it)', () => {
            const { component } = createClimateComponent({
                supportedFanModes: [ClimateFanMode.CLIMATE_FAN_AUTO],
            });
            const { accessory, context } = createFakeAccessory();

            climateHelper(component, accessory, createFakeApi());

            expect(context.services).toHaveLength(1);
        });

        it('adds no fan service for a plain on/off fan (HA builds none either)', () => {
            const { component } = createClimateComponent({
                supportedFanModes: [ClimateFanMode.CLIMATE_FAN_OFF, ClimateFanMode.CLIMATE_FAN_ON],
            });
            const { accessory, context } = createFakeAccessory();

            climateHelper(component, accessory, createFakeApi());

            expect(context.services).toHaveLength(1);
        });

        it('on a swing-only device, both Active write directions reject and no speed or auto rows exist', async () => {
            const climate = createClimateComponent({
                supportedFanModes: [],
                supportedSwingModes: [ClimateSwingMode.CLIMATE_SWING_OFF, ClimateSwingMode.CLIMATE_SWING_BOTH],
            });
            const { accessory, context } = createFakeAccessory();
            climateHelper(climate.component, accessory, createFakeApi());
            const fan = context.services[1] as unknown as FakeHapService;
            const active = fanCharacteristicOf(accessory, ACTIVE);

            expect(context.services).toHaveLength(2); // Thermostat + swing-only Fanv2
            expect(fan.testCharacteristic(ROTATION_SPEED)).toBe(false);
            expect(fan.testCharacteristic(TARGET_FAN_STATE)).toBe(false);

            // No FAN_OFF and no on-mode: every Active write is uncommandable.
            await expect(invokeSet(ACTIVE.INACTIVE, active)).rejects.toThrow(FakeHapStatusError);
            await expect(invokeSet(ACTIVE.ACTIVE, active)).rejects.toThrow(FakeHapStatusError);
            expect(climate.commands).toHaveLength(0);
        });

        it('keeps every fan characteristic untouched on a missing_state frame', () => {
            const { state, accessory } = setupFan();
            const active = fanCharacteristicOf(accessory, ACTIVE);
            const targetFanState = fanCharacteristicOf(accessory, TARGET_FAN_STATE);
            const currentFanState = fanCharacteristicOf(accessory, CURRENT_FAN_STATE);
            const swingMode = fanCharacteristicOf(accessory, SWING_MODE);

            // AUTO first, so a fictional TargetFanState push claiming "not
            // auto" over the missing_state frame would flip the value.
            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT,
                action: ClimateAction.CLIMATE_ACTION_FAN,
                fanMode: ClimateFanMode.CLIMATE_FAN_AUTO,
                swingMode: ClimateSwingMode.CLIMATE_SWING_BOTH,
            });
            expect(active.value).toBe(ACTIVE.ACTIVE);
            expect(targetFanState.value).toBe(TARGET_FAN_STATE.AUTO);
            expect(currentFanState.value).toBe(CURRENT_FAN_STATE.BLOWING_AIR);
            expect(swingMode.value).toBe(SWING_MODE.SWING_ENABLED);

            pushState(state, { missingState: true });
            // None of the rows may claim a concrete OFF/INACTIVE over the last
            // real reading.
            expect(active.value).toBe(ACTIVE.ACTIVE);
            expect(targetFanState.value).toBe(TARGET_FAN_STATE.AUTO);
            expect(currentFanState.value).toBe(CURRENT_FAN_STATE.BLOWING_AIR);
            expect(swingMode.value).toBe(SWING_MODE.SWING_ENABLED);
        });

        it('adds no fan service for custom fan modes only (no speed, auto or toggle to control)', () => {
            const { component } = createClimateComponent({
                supportedFanModes: [],
                supportedCustomFanModes: ['Nature', 'Sleep'],
            });
            const { accessory, context } = createFakeAccessory();

            climateHelper(component, accessory, createFakeApi());

            expect(context.services).toHaveLength(1);
        });

        it('adds no SwingMode characteristic when the device lists no swing-off mode', () => {
            const { accessory } = setupFan({
                supportedSwingModes: [ClimateSwingMode.CLIMATE_SWING_BOTH],
            });
            const fan = accessory.services[1] as unknown as FakeHapService;

            expect(fan.testCharacteristic(SWING_MODE)).toBe(false);
        });

        it('auto-adds only characteristics real hap lists as optional for Fanv2', () => {
            const { component } = createClimateComponent({
                supportedFanModes: [
                    ClimateFanMode.CLIMATE_FAN_OFF,
                    ClimateFanMode.CLIMATE_FAN_ON,
                    ClimateFanMode.CLIMATE_FAN_AUTO,
                    ClimateFanMode.CLIMATE_FAN_LOW,
                    ClimateFanMode.CLIMATE_FAN_MEDIUM,
                    ClimateFanMode.CLIMATE_FAN_HIGH,
                ],
                supportedSwingModes: [ClimateSwingMode.CLIMATE_SWING_OFF, ClimateSwingMode.CLIMATE_SWING_BOTH],
            });
            const thermostatService = new ThermostatService('TestClimate');
            const existingFanService = new Fanv2Service('TestClimate Fan');
            // Real hap Service.Fanv2 lists CurrentFanState, TargetFanState,
            // LockPhysicalControls, Name, RotationDirection, RotationSpeed and
            // SwingMode among its optional characteristics
            // (ServiceDefinitions.js:446-452).
            existingFanService.optionalCharacteristics = [
                CURRENT_FAN_STATE,
                TARGET_FAN_STATE,
                ROTATION_SPEED,
                SWING_MODE,
            ];
            const { accessory, context } = createFakeAccessory(thermostatService, existingFanService);

            climateHelper(component, accessory, createFakeApi());

            const fan = context.services[1] as unknown as FakeHapService;
            expect(fan.autoAddedUnlistedCharacteristics).toHaveLength(0);
            expect(fan.testCharacteristic(ROTATION_SPEED)).toBe(true);
            expect(fan.testCharacteristic(TARGET_FAN_STATE)).toBe(true);
            expect(fan.testCharacteristic(SWING_MODE)).toBe(true);
            expect(fan.testCharacteristic(CURRENT_FAN_STATE)).toBe(true);
        });
    });

    describe('push policy', () => {
        it('device state pushes never send commands back to the device', () => {
            const { component, state, commands } = createClimateComponent({
                supportsTwoPointTargetTemperature: true,
                supportsCurrentHumidity: true,
                supportsTargetHumidity: true,
                supportedFanModes: [
                    ClimateFanMode.CLIMATE_FAN_OFF,
                    ClimateFanMode.CLIMATE_FAN_ON,
                    ClimateFanMode.CLIMATE_FAN_AUTO,
                    ClimateFanMode.CLIMATE_FAN_LOW,
                ],
                supportedSwingModes: [ClimateSwingMode.CLIMATE_SWING_OFF, ClimateSwingMode.CLIMATE_SWING_BOTH],
            });
            const { accessory } = createFakeAccessory();
            climateHelper(component, accessory, createFakeApi());

            pushState(state, {
                mode: ClimateMode.CLIMATE_MODE_HEAT_COOL,
                currentTemperature: 21,
                targetTemperatureLow: 19,
                targetTemperatureHigh: 24,
                action: ClimateAction.CLIMATE_ACTION_HEATING,
                fanMode: ClimateFanMode.CLIMATE_FAN_LOW,
                swingMode: ClimateSwingMode.CLIMATE_SWING_BOTH,
                currentHumidity: 50,
                targetHumidity: 55,
            });

            expect(commands).toHaveLength(0);
        });
    });
});
