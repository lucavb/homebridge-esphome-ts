import { describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue } from 'homebridge';
import { BehaviorSubject, filter, type Observable } from 'rxjs';
import type { BaseComponent } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding } from './componentBinding.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    FakeHapStatusError,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    type FakeHapCharacteristic,
    type FakeHapService,
} from '../testing/hapFakes.js';

const ON_CHARACTERISTIC = makeFakeCharacteristicClass('on-uuid');
const CURRENT_VALUE_CHARACTERISTIC = makeFakeCharacteristicClass('current-value-uuid');

const SwitchService = makeFakeServiceClass('switch-service-uuid', [ON_CHARACTERISTIC]);
const SensorService = makeFakeServiceClass('sensor-service-uuid', [CURRENT_VALUE_CHARACTERISTIC]);
const LightbulbService = makeFakeServiceClass('lightbulb-uuid', [ON_CHARACTERISTIC]);
const EffectSwitchService = makeFakeServiceClass('effect-switch-uuid', [ON_CHARACTERISTIC]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { Switch: SwitchService, Sensor: SensorService },
            Characteristic: { On: ON_CHARACTERISTIC, CurrentValue: CURRENT_VALUE_CHARACTERISTIC },
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

interface FakeComponent {
    state$: Observable<unknown>;
}

const createFakeComponent = (): {
    component: BaseComponent;
    raw: FakeComponent;
    state: BehaviorSubject<unknown>;
    state$: Observable<unknown>;
} => {
    // Faithful to esphome-ts v4 state$: BehaviorSubject(undefined) + filter — current state
    // replays to late subscribers (esphome-ts dist/index.js:2777-2788). Tests that intend
    // "a push happens only after bind" push after bindComponent below (before-bind pushes
    // would be replayed on bind instead of dropped).
    const state = new BehaviorSubject<unknown>(undefined);
    const state$ = state.pipe(filter((value) => value !== undefined));
    const raw: FakeComponent = { state$ };
    return {
        /** Boundary cast: only state$ is exercised by bindComponent. */
        component: raw as unknown as BaseComponent,
        raw,
        state,
        state$,
    };
};

/** Boundary cast: fake hap classes duck into the real binding row types. */
const fakeBindings = (rows: unknown[]): ComponentBinding[] => rows as unknown as ComponentBinding[];

/** Invokes the stored onSet handler directly (setValue would swallow a rejection). */
const invokeSet = async (characteristic: FakeHapCharacteristic, value: CharacteristicValue): Promise<unknown> => {
    const handler = characteristic.setHandler;
    ok(handler, 'expected an onSet handler to be registered');
    return await handler(value);
};

/** Invokes the stored onGet handler, failing loudly when none is registered. */
const invokeGet = async (characteristic: FakeHapCharacteristic): Promise<unknown> => {
    const handler = characteristic.getHandler;
    ok(handler, 'expected an onGet handler to be registered');
    return await handler();
};

/** Lets setValue's re-entered onSet handler (async) settle before asserting effects. */
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('bindComponent', () => {
    it('find-or-add: adds the row service when the accessory has none', () => {
        const { component } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SwitchService,
                name: 'TestSwitch',
                characteristic: ON_CHARACTERISTIC,
                project: () => false,
            } as unknown as ComponentBinding,
        ]);

        expect(context.services).toHaveLength(1);
        const service = context.services[0];
        expect(service.UUID).toBe('switch-service-uuid');
        expect(service.name).toBe('TestSwitch');
        expect(service.subtype).toBe('');
    });

    it('find-or-add: reuses an existing service instead of adding one', () => {
        const { component } = createFakeComponent();
        const existing = new SwitchService('TestSwitch');
        const { accessory, context } = createFakeAccessory(existing);
        const addSpy = vi.spyOn(accessory, 'addService');

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SwitchService,
                name: 'TestSwitch',
                characteristic: ON_CHARACTERISTIC,
                project: () => false,
            } as unknown as ComponentBinding,
        ]);

        expect(addSpy).not.toHaveBeenCalled();
        expect(context.services).toHaveLength(1);
    });

    it('find-or-add: matches the service subtype separately from the UUID', () => {
        const { component } = createFakeComponent();
        const existing = new SwitchService('existing effect switch', 'rainbow Switch');
        const { accessory, context } = createFakeAccessory(existing);

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SwitchService,
                name: 'different effect switch',
                subtype: 'strobe Switch',
                characteristic: ON_CHARACTERISTIC,
                project: () => false,
            } as unknown as ComponentBinding,
        ]);

        // The UUID alone must not match the effect switch's subtype; a new service is added.
        expect(context.services).toHaveLength(2);
        expect(context.services[1].subtype).toBe('strobe Switch');
        expect(context.services[1].name).toBe('different effect switch');
    });

    it('pushes projected state on state$ emissions with updateValue', () => {
        const { component, state } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SensorService,
                name: 'TestSensor',
                characteristic: CURRENT_VALUE_CHARACTERISTIC,
                project: (state: unknown) => (typeof state === 'number' ? state : undefined),
            } as unknown as ComponentBinding,
        ]);

        const characteristic = assertCharacteristic(context.services[0], CURRENT_VALUE_CHARACTERISTIC);

        state.next(21);
        expect(characteristic.value).toBe(21);
    });

    it('skips the push when project returns undefined', () => {
        const { component, state } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SensorService,
                name: 'TestSensor',
                characteristic: CURRENT_VALUE_CHARACTERISTIC,
                project: (state: unknown) => (typeof state === 'number' ? state : undefined),
            } as unknown as ComponentBinding,
        ]);

        const characteristic = assertCharacteristic(context.services[0], CURRENT_VALUE_CHARACTERISTIC);
        state.next('not a measurement');
        expect(characteristic.value).toBeUndefined();
    });

    it('unsubscribes all row pushes on teardown', () => {
        const { component, state } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();

        const teardown = bindComponent(component, accessory, createFakeApi(), [
            {
                service: SensorService,
                name: 'TestSensor',
                characteristic: CURRENT_VALUE_CHARACTERISTIC,
                project: (state: unknown) => (typeof state === 'number' ? state : undefined),
            } as unknown as ComponentBinding,
        ]);
        const characteristic = assertCharacteristic(context.services[0], CURRENT_VALUE_CHARACTERISTIC);

        teardown();
        state.next(7);

        expect(characteristic.value).toBeUndefined();
    });

    it('wires apply through onSet and translates handler throws into HapStatusError', async () => {
        const { component } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();
        const apply = vi.fn(() => {
            throw new Error('device gone');
        });

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SwitchService,
                name: 'TestSwitch',
                characteristic: ON_CHARACTERISTIC,
                apply,
            } as unknown as ComponentBinding,
        ]);

        const characteristic = assertCharacteristic(context.services[0], ON_CHARACTERISTIC);
        await expect(invokeSet(characteristic, true)).rejects.toThrow(FakeHapStatusError);
        await expect(invokeSet(characteristic, true)).rejects.toMatchObject({
            hapStatus: 'SERVICE_COMMUNICATION_FAILURE',
        });
        await flush();
        expect(apply).toHaveBeenCalledWith(true);
    });

    it('wires read through onGet with the same HapStatusError wrap', async () => {
        const { component } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SensorService,
                name: 'TestSensor',
                characteristic: CURRENT_VALUE_CHARACTERISTIC,
                read: () => 42,
            } as unknown as ComponentBinding,
        ]);

        const characteristic = assertCharacteristic(context.services[0], CURRENT_VALUE_CHARACTERISTIC);
        expect(await invokeGet(characteristic)).toBe(42);

        const failing = createFakeComponent();
        const failingAccessory = createFakeAccessory();
        bindComponent(failing.component, failingAccessory.accessory, createFakeApi(), [
            {
                service: SensorService,
                name: 'TestSensor',
                characteristic: CURRENT_VALUE_CHARACTERISTIC,
                read: vi.fn(() => {
                    throw new Error('device gone');
                }),
            } as unknown as ComponentBinding,
        ]);
        const failingCharacteristic = assertCharacteristic(
            failingAccessory.context.services[0],
            CURRENT_VALUE_CHARACTERISTIC,
        );
        await expect(invokeGet(failingCharacteristic)).rejects.toThrow(FakeHapStatusError);
        await expect(invokeGet(failingCharacteristic)).rejects.toMatchObject({
            hapStatus: 'SERVICE_COMMUNICATION_FAILURE',
        });
    });

    it('a radioGroup apply pushes updateValue(false) to sibling rows, not to the applying row', async () => {
        const { component } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();
        const siblingApply = vi.fn();

        bindComponent(
            component,
            accessory,
            createFakeApi(),
            fakeBindings([
                {
                    service: SwitchService,
                    name: 'TestSwitch - rainbow',
                    subtype: 'rainbow Switch',
                    characteristic: ON_CHARACTERISTIC,
                    apply: () => undefined,
                    radioGroup: 'TestSwitch-effects',
                },
                {
                    service: SwitchService,
                    name: 'TestSwitch - strobe',
                    subtype: 'strobe Switch',
                    characteristic: ON_CHARACTERISTIC,
                    apply: siblingApply,
                    radioGroup: 'TestSwitch-effects',
                },
                {
                    service: SwitchService,
                    name: 'TestSwitch - unrelated',
                    subtype: 'unrelated Switch',
                    characteristic: ON_CHARACTERISTIC,
                    apply: vi.fn(),
                },
            ]),
        );

        const onCharacteristic = (service: FakeHapService) => assertCharacteristic(service, ON_CHARACTERISTIC);
        const rainbow = onCharacteristic(context.services[0]);
        const strobe = onCharacteristic(context.services[1]);
        const unrelated = onCharacteristic(context.services[2]);

        await invokeSet(rainbow, true);
        await flush();

        expect(strobe.value).toBe(false);
        expect(siblingApply).not.toHaveBeenCalled(); // updateValue skips the sibling's onSet
        expect(unrelated.value).toBeUndefined();
        expect(rainbow.value).toBeUndefined(); // the applying row itself is never touched
    });

    it('a device push never re-enters the row apply, even when the value is out of sync', async () => {
        // Faithful to esphome-ts v4 state$: BehaviorSubject(undefined) + filter — current
        // state replays to late subscribers (esphome-ts dist/index.js:2777-2788). Both
        // pushes below happen after bindComponent subscribed, so replay never applies.
        const state = new BehaviorSubject<unknown>(undefined);
        const state$ = state.pipe(filter((value) => value !== undefined));
        const turnOn = vi.fn();
        const turnOff = vi.fn();
        const raw = { state$, status: false, turnOn, turnOff };
        const component = raw as unknown as BaseComponent;
        const { accessory, context } = createFakeAccessory();

        bindComponent(component, accessory, createFakeApi(), [
            {
                service: SwitchService,
                name: 'TestSwitch',
                characteristic: ON_CHARACTERISTIC,
                apply: (value: CharacteristicValue) => {
                    if (raw.status !== !!value) {
                        if (value) {
                            raw.turnOn();
                        } else {
                            raw.turnOff();
                        }
                    }
                },
                project: (state: unknown) => (typeof state === 'boolean' ? state : undefined),
            } as unknown as ComponentBinding,
        ]);

        const characteristic = assertCharacteristic(context.services[0], ON_CHARACTERISTIC);

        // The push lands the value silently; even a value that disagrees with the component
        // status (a stale device report) must not echo a command through the onSet handler.
        state.next(true);
        await flush(); // let a wrong setValue re-entry (if ever introduced) settle
        expect(characteristic.value).toBe(true);
        expect(turnOn).not.toHaveBeenCalled();

        raw.status = true;
        state.next(true);
        await flush();
        expect(characteristic.value).toBe(true);
        expect(turnOn).not.toHaveBeenCalled();
        expect(turnOff).not.toHaveBeenCalled();
    });

    it('an updateValue push does not re-enter the row apply', async () => {
        const { component, state } = createFakeComponent();
        const { accessory, context } = createFakeAccessory();
        const apply = vi.fn();

        bindComponent(
            component,
            accessory,
            createFakeApi(),
            fakeBindings([
                {
                    service: SensorService,
                    name: 'TestSensor',
                    characteristic: CURRENT_VALUE_CHARACTERISTIC,
                    apply,
                    project: (state: unknown) => (typeof state === 'number' ? state : undefined),
                },
            ]),
        );

        const characteristic = assertCharacteristic(context.services[0], CURRENT_VALUE_CHARACTERISTIC);

        state.next(5);
        await flush(); // let a wrong setValue re-entry (if ever introduced) settle

        expect(characteristic.value).toBe(5);
        expect(apply).not.toHaveBeenCalled();
    });

    it('a light-shaped state echo with multiple effects never re-sends an effect command', async () => {
        // Faithful to esphome-ts v4 state$: BehaviorSubject(undefined) + filter — current
        // state replays to late subscribers (esphome-ts dist/index.js:2777-2788). The
        // push below happens after bindComponent subscribed, so replay never applies.
        const state = new BehaviorSubject<unknown>(undefined);
        const state$ = state.pipe(filter((value) => value !== undefined));
        const turnOn = vi.fn();
        const turnOff = vi.fn();
        const raw = { state$, state: true, effect: 'None', turnOn, turnOff };
        const { accessory, context } = createFakeAccessory();

        bindComponent(
            raw as unknown as BaseComponent,
            accessory,
            createFakeApi(),
            fakeBindings([
                {
                    service: LightbulbService,
                    name: 'TestLight',
                    characteristic: ON_CHARACTERISTIC,
                    apply: (value: CharacteristicValue) => {
                        if (value) {
                            raw.turnOn();
                        } else {
                            raw.turnOff();
                        }
                    },
                    project: () => !!raw.state,
                },
                {
                    service: EffectSwitchService,
                    name: 'TestLight - rainbow',
                    subtype: 'rainbow Switch',
                    characteristic: ON_CHARACTERISTIC,
                    apply: (value: CharacteristicValue) => {
                        raw.effect = value ? 'rainbow' : 'None';
                    },
                    project: () => raw.effect === 'rainbow',
                    radioGroup: 'TestLight-effects',
                },
                {
                    service: EffectSwitchService,
                    name: 'TestLight - strobe',
                    subtype: 'strobe Switch',
                    characteristic: ON_CHARACTERISTIC,
                    apply: (value: CharacteristicValue) => {
                        raw.effect = value ? 'strobe' : 'None';
                    },
                    project: () => raw.effect === 'strobe',
                    radioGroup: 'TestLight-effects',
                },
            ]),
        );

        const bulbOn = assertCharacteristic(context.services[0], ON_CHARACTERISTIC);
        const rainbowOn = assertCharacteristic(context.services[1], ON_CHARACTERISTIC);
        const strobeOn = assertCharacteristic(context.services[2], ON_CHARACTERISTIC);

        // A pure state echo (device confirmed what the plugin last pushed) must land in the
        // characteristics but NOT re-fire any onSet handler/command side effects.
        raw.state = true;
        raw.effect = 'rainbow';
        state.next({ state: true, effect: 'rainbow' });
        await flush();

        expect(bulbOn.value).toBe(true);
        expect(rainbowOn.value).toBe(true);
        expect(strobeOn.value).toBe(false);
        expect(turnOn).not.toHaveBeenCalled();
        expect(turnOff).not.toHaveBeenCalled();
        expect(raw.effect).toBe('rainbow'); // inactive effect rows must not reset to NO_EFFECT
    });
});
