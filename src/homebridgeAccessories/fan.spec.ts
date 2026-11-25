import { afterEach, describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { Subject } from 'rxjs';
import { FanComponent, FanDirection, FanSpeed } from 'esphome-ts';
import type { BaseComponent, CommandInterface, FanEntity, FanStateEvent } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { fanHelper } from './fan.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    FakeHapStatusError,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    type FakeHapCharacteristic,
    type FakeHapService,
} from '../testing/hapFakes.js';

const ActiveCharacteristic = Object.assign(makeFakeCharacteristicClass('active-uuid'), {
    ACTIVE: 1,
    INACTIVE: 0,
});
const RotationSpeedCharacteristic = makeFakeCharacteristicClass('rotation-speed-uuid');
const RotationDirectionCharacteristic = Object.assign(makeFakeCharacteristicClass('rotation-direction-uuid'), {
    CLOCKWISE: 0,
    COUNTER_CLOCKWISE: 1,
});
const SwingModeCharacteristic = Object.assign(makeFakeCharacteristicClass('swing-mode-uuid'), {
    SWING_DISABLED: 0,
    SWING_ENABLED: 1,
});
const OnCharacteristic = makeFakeCharacteristicClass('on-uuid');

const Fanv2Service = makeFakeServiceClass('fanv2-uuid', [ActiveCharacteristic]);
const SwitchService = makeFakeServiceClass('switch-uuid', [OnCharacteristic]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { Fanv2: Fanv2Service, Switch: SwitchService },
            Characteristic: {
                Active: ActiveCharacteristic,
                RotationSpeed: RotationSpeedCharacteristic,
                RotationDirection: RotationDirectionCharacteristic,
                SwingMode: SwingModeCharacteristic,
                On: OnCharacteristic,
            },
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

const makeEntity = (overrides: Partial<FanEntity> = {}): FanEntity => ({
    key: 42,
    name: 'Test Fan',
    objectId: 'test_fan',
    uniqueId: 'test-fan',
    supportsOscillation: true,
    supportsSpeed: true,
    supportsDirection: true,
    supportedSpeedCount: 3,
    supportedPresetModes: ['auto', 'sleep'],
    ...overrides,
});

const createdFans: Array<{ component: FanComponent; state: Subject<FanStateEvent> }> = [];

const createFan = (
    overrides: Partial<FanEntity> = {},
    apiVersion: { major: number; minor: number } = { major: 1, minor: 6 },
) => {
    const state = new Subject<FanStateEvent>();
    const commandInterface: CommandInterface = { sendEspMessage: vi.fn() };
    const component = new FanComponent(makeEntity(overrides), state.asObservable(), commandInterface, apiVersion);
    createdFans.push({ component, state });
    return { component, state };
};

afterEach(() => {
    for (const { component, state } of createdFans) {
        component.terminate();
        state.complete();
    }
    createdFans.length = 0;
});

const invokeSet = async (characteristic: FakeHapCharacteristic, value: CharacteristicValue): Promise<unknown> => {
    const handler = characteristic.setHandler;
    ok(handler, 'expected an onSet handler to be registered');
    return await handler(value);
};

const invokeGet = async (characteristic: FakeHapCharacteristic): Promise<unknown> => {
    const handler = characteristic.getHandler;
    ok(handler, 'expected an onGet handler to be registered');
    return await handler();
};

const fanServiceOf = (accessory: PlatformAccessory): FakeHapService => {
    const service = (accessory.services as unknown as FakeHapService[]).find(({ UUID }) => UUID === 'fanv2-uuid');
    ok(service, 'expected a Fanv2 service');
    return service;
};

const presetServicesOf = (accessory: PlatformAccessory): FakeHapService[] =>
    (accessory.services as unknown as FakeHapService[]).filter(({ UUID }) => UUID === 'switch-uuid');

const characteristicsOf = (accessory: PlatformAccessory) => {
    const service = fanServiceOf(accessory);
    return {
        active: assertCharacteristic(service, ActiveCharacteristic),
        speed: assertCharacteristic(service, RotationSpeedCharacteristic),
        direction: assertCharacteristic(service, RotationDirectionCharacteristic),
        swing: assertCharacteristic(service, SwingModeCharacteristic),
    };
};

describe('fanHelper', () => {
    it('returns undefined for a component failing the instanceof guard', () => {
        const impostor = { name: 'impostor' } as unknown as BaseComponent;
        const { accessory, context } = createFakeAccessory();

        expect(fanHelper(impostor, accessory, createFakeApi())).toBeUndefined();
        expect(context.services).toHaveLength(0);
    });

    it('binds a minimal on/off fan as Fanv2 with Active only', async () => {
        const { component, state } = createFan({
            supportsSpeed: false,
            supportsOscillation: false,
            supportsDirection: false,
            supportedSpeedCount: 0,
            supportedPresetModes: [],
        });
        const { accessory, context } = createFakeAccessory();
        const teardown = fanHelper(component, accessory, createFakeApi());

        expect(teardown).toBeTypeOf('function');
        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'fanv2-uuid');

        const service = fanServiceOf(accessory);
        expect(service.testCharacteristic(RotationSpeedCharacteristic)).toBe(false);
        expect(service.testCharacteristic(RotationDirectionCharacteristic)).toBe(false);
        expect(service.testCharacteristic(SwingModeCharacteristic)).toBe(false);
        expect(presetServicesOf(accessory)).toHaveLength(0);

        const turnOn = vi.spyOn(component, 'turnOn');
        const turnOff = vi.spyOn(component, 'turnOff');
        const active = assertCharacteristic(service, ActiveCharacteristic);
        await invokeSet(active, 1);
        expect(turnOn).toHaveBeenCalledTimes(1);

        state.next({ key: 42, state: true });
        expect(active.value).toBe(1);
        await invokeSet(active, 0);
        expect(turnOff).toHaveBeenCalledTimes(1);
        state.next({ key: 42, state: false });
        expect(active.value).toBe(0);
    });

    const capabilityCases: Array<
        [string, Partial<FanEntity>, { readonly speed: boolean; readonly direction: boolean; readonly swing: boolean }]
    > = [
        [
            'speed only',
            { supportsSpeed: true, supportsDirection: false, supportsOscillation: false },
            {
                speed: true,
                direction: false,
                swing: false,
            },
        ],
        [
            'direction only',
            { supportsSpeed: false, supportsDirection: true, supportsOscillation: false },
            {
                speed: false,
                direction: true,
                swing: false,
            },
        ],
        [
            'oscillation only',
            { supportsSpeed: false, supportsDirection: false, supportsOscillation: true },
            {
                speed: false,
                direction: false,
                swing: true,
            },
        ],
    ];

    it.each(capabilityCases)('gates %s capabilities independently', (_, overrides, expected) => {
        const { component } = createFan(overrides);
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());

        const service = fanServiceOf(accessory);
        expect(service.testCharacteristic(RotationSpeedCharacteristic)).toBe(expected.speed);
        expect(service.testCharacteristic(RotationDirectionCharacteristic)).toBe(expected.direction);
        expect(service.testCharacteristic(SwingModeCharacteristic)).toBe(expected.swing);
    });

    it('does not bind speed when modern firmware reports a speed count of zero', () => {
        const { component } = createFan({ supportsSpeed: true, supportedSpeedCount: 0 });
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());

        expect(component.supportsSpeed).toBe(false);
        expect(fanServiceOf(accessory).testCharacteristic(RotationSpeedCharacteristic)).toBe(false);
    });

    it('reports numeric Active values and pushes device state through updateValue', () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { active } = characteristicsOf(accessory);
        const updateValue = vi.spyOn(active, 'updateValue');
        const setValue = vi.spyOn(active, 'setValue');

        state.next({ key: 42, state: true });
        expect(active.value).toBe(ActiveCharacteristic.ACTIVE);
        expect(updateValue).toHaveBeenCalledWith(ActiveCharacteristic.ACTIVE);
        expect(setValue).not.toHaveBeenCalled();

        state.next({ key: 42, state: false });
        expect(active.value).toBe(ActiveCharacteristic.INACTIVE);
        expect(updateValue).toHaveBeenCalledWith(ActiveCharacteristic.INACTIVE);
        expect(setValue).not.toHaveBeenCalled();
    });

    it('maps the retained speed while off and clamps an unknown level on a running fan', () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { speed } = characteristicsOf(accessory);

        state.next({ key: 42, state: true, speedLevel: 2 });
        expect(speed.value).toBe(66);

        state.next({ key: 42, state: false, speedLevel: 2 });
        expect(speed.value).toBe(66); // ESPHome retains the level; never push 0 on power-off.

        state.next({ key: 42, state: true, speedLevel: 0 });
        expect(speed.value).toBe(1); // HomeKit treats 0 as off, so a running fan reports at least 1.

        state.next({ key: 42, state: false, speedLevel: 0 });
        expect(speed.value).toBe(0);
    });

    it('applies speed percentages, leaving zero to the library as an off command', async () => {
        const { component } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { speed } = characteristicsOf(accessory);
        const setSpeed = vi.spyOn(component, 'setSpeedPercentage');

        await invokeSet(speed, 50);
        expect(setSpeed).toHaveBeenCalledWith(50);

        setSpeed.mockClear();
        await invokeSet(speed, 0);
        expect(setSpeed).toHaveBeenCalledWith(0);
    });

    it('maps direction both ways and honours invertFanDirection', async () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { direction } = characteristicsOf(accessory);
        const setDirection = vi.spyOn(component, 'setDirection');

        state.next({ key: 42, direction: FanDirection.FAN_DIRECTION_REVERSE });
        expect(direction.value).toBe(RotationDirectionCharacteristic.COUNTER_CLOCKWISE);

        state.next({ key: 42, direction: FanDirection.FAN_DIRECTION_FORWARD });
        expect(direction.value).toBe(RotationDirectionCharacteristic.CLOCKWISE);

        await invokeSet(direction, RotationDirectionCharacteristic.CLOCKWISE);
        expect(setDirection).toHaveBeenCalledWith(FanDirection.FAN_DIRECTION_FORWARD);

        setDirection.mockClear();
        await invokeSet(direction, RotationDirectionCharacteristic.COUNTER_CLOCKWISE);
        expect(setDirection).toHaveBeenCalledWith(FanDirection.FAN_DIRECTION_REVERSE);

        const inverted = createFan();
        const invertedAccessory = createFakeAccessory();
        fanHelper(inverted.component, invertedAccessory.accessory, createFakeApi(), { invertFanDirection: true });
        const invertedDirection = characteristicsOf(invertedAccessory.accessory).direction;
        const invertedSetDirection = vi.spyOn(inverted.component, 'setDirection');

        inverted.state.next({ key: 42, direction: FanDirection.FAN_DIRECTION_FORWARD });
        expect(invertedDirection.value).toBe(RotationDirectionCharacteristic.COUNTER_CLOCKWISE);

        await invokeSet(invertedDirection, RotationDirectionCharacteristic.CLOCKWISE);
        expect(invertedSetDirection).toHaveBeenCalledWith(FanDirection.FAN_DIRECTION_REVERSE);

        invertedSetDirection.mockClear();
        await invokeSet(invertedDirection, RotationDirectionCharacteristic.COUNTER_CLOCKWISE);
        expect(invertedSetDirection).toHaveBeenCalledWith(FanDirection.FAN_DIRECTION_FORWARD);
    });

    it('serves bounded defaults on GET before the first state and reported values after', async () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { active, speed, direction, swing } = characteristicsOf(accessory);

        expect(await invokeGet(active)).toBe(ActiveCharacteristic.INACTIVE);
        expect(await invokeGet(speed)).toBe(0);
        expect(await invokeGet(direction)).toBe(RotationDirectionCharacteristic.CLOCKWISE);
        expect(await invokeGet(swing)).toBe(SwingModeCharacteristic.SWING_DISABLED);

        state.next({
            key: 42,
            state: true,
            speedLevel: 3,
            direction: FanDirection.FAN_DIRECTION_REVERSE,
            oscillating: true,
        });

        expect(await invokeGet(active)).toBe(ActiveCharacteristic.ACTIVE);
        expect(await invokeGet(speed)).toBe(100);
        expect(await invokeGet(direction)).toBe(RotationDirectionCharacteristic.COUNTER_CLOCKWISE);
        expect(await invokeGet(swing)).toBe(SwingModeCharacteristic.SWING_ENABLED);
    });

    it('serves the inverted pre-state direction on GET', async () => {
        const { component } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi(), { invertFanDirection: true });
        const { direction } = characteristicsOf(accessory);

        expect(await invokeGet(direction)).toBe(RotationDirectionCharacteristic.COUNTER_CLOCKWISE);
    });

    it('skips direction, oscillation and invalid speed/direction writes while unknown', async () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { speed, direction, swing } = characteristicsOf(accessory);

        state.next({ key: 42, state: true, speedLevel: 2 }); // no direction/oscillating fields
        expect(direction.value).toBeUndefined();
        expect(swing.value).toBeUndefined();

        const setDirection = vi.spyOn(component, 'setDirection');
        await invokeSet(direction, 2); // not a HAP enum value
        expect(setDirection).not.toHaveBeenCalled();

        const setSpeed = vi.spyOn(component, 'setSpeedPercentage');
        await invokeSet(speed, true); // not a number
        expect(setSpeed).not.toHaveBeenCalled();
    });

    it('does not send a redundant on/off command when Active already matches', async () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { active } = characteristicsOf(accessory);
        const turnOn = vi.spyOn(component, 'turnOn');
        const turnOff = vi.spyOn(component, 'turnOff');

        state.next({ key: 42, state: true });
        await invokeSet(active, ActiveCharacteristic.ACTIVE);
        expect(turnOn).not.toHaveBeenCalled();

        state.next({ key: 42, state: false });
        await invokeSet(active, ActiveCharacteristic.INACTIVE);
        expect(turnOff).not.toHaveBeenCalled();
    });

    it('maps oscillation onto SwingMode', async () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { swing } = characteristicsOf(accessory);
        const setOscillating = vi.spyOn(component, 'setOscillating');

        state.next({ key: 42, oscillating: true });
        expect(swing.value).toBe(SwingModeCharacteristic.SWING_ENABLED);

        state.next({ key: 42, oscillating: false });
        expect(swing.value).toBe(SwingModeCharacteristic.SWING_DISABLED);

        await invokeSet(swing, SwingModeCharacteristic.SWING_ENABLED);
        expect(setOscillating).toHaveBeenCalledWith(true);

        setOscillating.mockClear();
        await invokeSet(swing, SwingModeCharacteristic.SWING_DISABLED);
        expect(setOscillating).toHaveBeenCalledWith(false);
    });

    it('binds one radio-group switch per advertised preset and clears only the active one', async () => {
        const { component, state } = createFan({ supportedPresetModes: ['auto', 'sleep', ''] });
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());

        const presetServices = presetServicesOf(accessory);
        expect(presetServices).toHaveLength(2);
        expect(presetServices.map(({ name }) => name)).toEqual(['Test Fan - auto', 'Test Fan - sleep']);
        expect(presetServices.map(({ subtype }) => subtype)).toEqual(['auto Fan Preset', 'sleep Fan Preset']);

        const autoService = presetServices.find(({ subtype }) => subtype === 'auto Fan Preset');
        const sleepService = presetServices.find(({ subtype }) => subtype === 'sleep Fan Preset');
        ok(autoService);
        ok(sleepService);
        const auto = assertCharacteristic(autoService, OnCharacteristic);
        const sleep = assertCharacteristic(sleepService, OnCharacteristic);

        state.next({ key: 42, presetMode: 'auto' });
        expect(auto.value).toBe(true);
        expect(sleep.value).toBe(false);
        // Preset rows serve the live selected state, like the light effect rows.
        expect(await invokeGet(auto)).toBe(true);
        expect(await invokeGet(sleep)).toBe(false);

        const setPreset = vi.spyOn(component, 'setPresetMode');
        await invokeSet(sleep, false); // inactive preset: must not clear the active one
        expect(setPreset).not.toHaveBeenCalled();
        expect(auto.value).toBe(true); // and must not visually deselect the active preset

        await invokeSet(auto, false);
        expect(setPreset).toHaveBeenCalledWith('');

        setPreset.mockClear();
        await invokeSet(sleep, true);
        expect(setPreset).toHaveBeenCalledWith('sleep');
        expect(auto.value).toBe(false); // radio group pushes the sibling off after a successful apply
    });

    it('translates legacy three-speed state without branching in the helper', () => {
        const { component, state } = createFan({ supportedSpeedCount: 0 }, { major: 1, minor: 3 });
        const { accessory } = createFakeAccessory();
        fanHelper(component, accessory, createFakeApi());
        const { speed } = characteristicsOf(accessory);

        state.next({ key: 42, state: true, speed: FanSpeed.FAN_SPEED_LOW });
        expect(speed.value).toBe(33);

        state.next({ key: 42, state: true, speed: FanSpeed.FAN_SPEED_MEDIUM });
        expect(speed.value).toBe(66);

        state.next({ key: 42, state: true, speed: FanSpeed.FAN_SPEED_HIGH });
        expect(speed.value).toBe(100);
    });

    it('pushes the state the device reported before binding', () => {
        const { component, state } = createFan();
        // The component's own state BehaviorSubject replays the latest report to a late
        // subscriber, so a helper bound after the first frame must still push it.
        state.next({ key: 42, state: true, speedLevel: 3, oscillating: true });
        const { accessory } = createFakeAccessory();

        fanHelper(component, accessory, createFakeApi());

        const { active, speed, swing } = characteristicsOf(accessory);
        expect(active.value).toBe(ActiveCharacteristic.ACTIVE);
        expect(speed.value).toBe(100);
        expect(swing.value).toBe(SwingModeCharacteristic.SWING_ENABLED);
    });

    it('stops pushing state after teardown', () => {
        const { component, state } = createFan();
        const { accessory } = createFakeAccessory();
        const teardown = fanHelper(component, accessory, createFakeApi());
        const { active } = characteristicsOf(accessory);

        state.next({ key: 42, state: true });
        expect(active.value).toBe(1);

        teardown?.();
        state.next({ key: 42, state: false });
        expect(active.value).toBe(1);
    });
});
