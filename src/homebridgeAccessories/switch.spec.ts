import { describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { BehaviorSubject, filter } from 'rxjs';
import { SwitchComponent } from 'esphome-ts';
import type { BaseComponent } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { switchHelper } from './switch.js';
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
const SwitchService = makeFakeServiceClass('switch-service-uuid', [ON_CHARACTERISTIC]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { Switch: SwitchService },
            Characteristic: { On: ON_CHARACTERISTIC },
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

const createFakeSwitchComponent = (options?: { throwOnCall?: boolean }) => {
    /**
     * Faithful to esphome-ts v5 state$: built from a BehaviorSubject(undefined) filtered on
     * undefined, so late subscribers (each binding row) get the current state replayed at
     * subscribe time (esphome-ts dist/index.js:2837, 2819-2826). v5 shallow-compare dedup drops
     * identical re-sent states upstream of the contract this fake models.
     */
    const state = new BehaviorSubject<unknown>(undefined);
    const state$ = state.pipe(filter((value) => value !== undefined));
    const turnOn = vi.fn(() => {
        if (options?.throwOnCall) {
            throw new Error('device gone');
        }
    });
    const turnOff = vi.fn(() => {
        if (options?.throwOnCall) {
            throw new Error('device gone');
        }
    });
    let status = false;

    /**
     * Boundary fake: sits on the real SwitchComponent.prototype and shadows the live surface the
     * helper reads. The guard stays on the library: isSwitchComponent narrows with
     * `component.type === 'switch'` (esphome-ts dist/index.js:3429), and SwitchComponent serves
     * that from a prototype getter returning 'switch' (dist/index.js:3133-3135), so the inherited
     * getter satisfies isSwitchComponent — no spec-owned 'type' property is needed.
     */
    const component = Object.create(SwitchComponent.prototype) as SwitchComponent;
    Object.defineProperty(component, 'name', { enumerable: true, get: () => 'TestSwitch' });
    Object.defineProperty(component, 'state$', { enumerable: true, get: () => state$ });
    Object.defineProperty(component, 'status', { enumerable: true, get: () => status });
    Object.defineProperty(component, 'turnOn', { enumerable: true, value: turnOn });
    Object.defineProperty(component, 'turnOff', { enumerable: true, value: turnOff });

    /** Mutable handle for the shadowed fields: flipping raw.status changes the live readback. */
    const raw = {
        get status(): boolean {
            return status;
        },
        set status(value: boolean) {
            status = value;
        },
    };

    return { component, raw, state, turnOn, turnOff };
};

/** Lets setValue's re-entered onSet handler (async) settle before asserting effects. */
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Returns the On characteristic of the Switch service the helper wired up,
 * failing loudly instead of returning undefined.
 */
const onCharacteristicOf = (accessory: PlatformAccessory): FakeHapCharacteristic => {
    const service = accessory.services[0] as unknown as FakeHapService;
    return assertCharacteristic(service, ON_CHARACTERISTIC);
};

/** Invokes the stored onSet handler directly (setValue would swallow its rejection). */
const invokeSet = async (value: CharacteristicValue, characteristic: FakeHapCharacteristic): Promise<unknown> => {
    const handler = characteristic.setHandler;
    ok(handler, 'expected the On onSet handler to be registered');
    return await handler(value);
};

describe('switchHelper', () => {
    it('returns undefined for a component failing the isSwitchComponent guard without touching the accessory', () => {
        // A plain object is not on SwitchComponent.prototype; the guard checks
        // `component.type === 'switch'` (esphome-ts dist/index.js:3429), which a bare object
        // never satisfies (its own `type` getter lives on the prototype, dist/index.js:3133-3135).
        const impostor = { name: 'impostor' } as unknown as BaseComponent;
        const { accessory, context } = createFakeAccessory();

        expect(switchHelper(impostor, accessory, createFakeApi())).toBeUndefined();
        expect(context.services).toHaveLength(0);
    });

    it('returns a teardown function (the boolean return is gone)', () => {
        const { component } = createFakeSwitchComponent();
        const { accessory } = createFakeAccessory();

        const teardown = switchHelper(component, accessory, createFakeApi());

        expect(teardown).toBeTypeOf('function');
        expect(() => teardown?.()).not.toThrow();
    });

    it('adds a Switch service when the accessory has none, with the component name', () => {
        const { component } = createFakeSwitchComponent();
        const { accessory, context } = createFakeAccessory();

        switchHelper(component, accessory, createFakeApi());

        expect(context.services).toHaveLength(1);
        const service = context.services[0];
        expect(service).toHaveProperty('UUID', 'switch-service-uuid');
        expect(service).toHaveProperty('name', 'TestSwitch');
    });

    it('reuses an existing Switch service instead of adding one', () => {
        const { component } = createFakeSwitchComponent();
        const existingService = new SwitchService('TestSwitch');
        const { accessory, context } = createFakeAccessory(existingService);
        const spyService = vi.spyOn(accessory, 'addService');

        switchHelper(component, accessory, createFakeApi());

        expect(spyService).not.toHaveBeenCalled();
        expect(context.services).toHaveLength(1);
    });

    it('wires the On characteristic of the created service through onSet', () => {
        const { component } = createFakeSwitchComponent();
        const { accessory } = createFakeAccessory();

        switchHelper(component, accessory, createFakeApi());

        const characteristic = onCharacteristicOf(accessory);
        expect(typeof characteristic.setHandler).toBe('function');
    });

    describe('onSet handler behavior', () => {
        const setup = ({ throwOnCall }: { throwOnCall?: boolean } = {}) => {
            const { component, raw, turnOn, turnOff } = createFakeSwitchComponent({ throwOnCall });
            const { accessory } = createFakeAccessory();

            switchHelper(component, accessory, createFakeApi());

            const characteristic = onCharacteristicOf(accessory);
            ok(characteristic.setHandler, 'expected the On onSet handler to be registered');
            const setHandler = (value: CharacteristicValue): Promise<unknown> => invokeSet(value, characteristic);
            return { component, raw, turnOn, turnOff, setHandler, characteristic, accessory };
        };

        it('turns the component on for truthy values when currently off', async () => {
            const { turnOn, turnOff, setHandler, raw } = setup();
            await setHandler(true);
            expect(raw.status).toBe(false); // remote state is unchanged by the handler itself
            expect(turnOn).toHaveBeenCalledTimes(1);
            expect(turnOff).not.toHaveBeenCalled();
        });

        it('turns the component off for falsy values when currently on', async () => {
            const { turnOn, turnOff, setHandler, raw } = setup();
            raw.status = true;
            await setHandler(false);
            expect(turnOff).toHaveBeenCalledTimes(1);
            expect(turnOn).not.toHaveBeenCalled();
        });

        it('is a no-op when the component already has the requested state', async () => {
            const { turnOn, turnOff, setHandler, raw } = setup();
            raw.status = false;
            await setHandler(false);
            expect(turnOn).not.toHaveBeenCalled();
            expect(turnOff).not.toHaveBeenCalled();

            raw.status = true;
            await setHandler(true);
            expect(turnOn).not.toHaveBeenCalled();
            expect(turnOff).not.toHaveBeenCalled();
        });

        it('throws a HapStatusError with SERVICE_COMMUNICATION_FAILURE when the device write fails', async () => {
            const { setHandler, turnOn } = setup({ throwOnCall: true });
            turnOn.mockImplementation(() => {
                throw new Error('device gone');
            });
            await expect(setHandler(true)).rejects.toThrow(FakeHapStatusError);
            // The shared fake stores the hap status code, so the wrap's payload is pinned too.
            await expect(setHandler(true)).rejects.toMatchObject({ hapStatus: 'SERVICE_COMMUNICATION_FAILURE' });
        });

        it('treats truthy non-boolean values the same as true', async () => {
            const { turnOn, turnOff, setHandler } = setup();
            await setHandler(100 as unknown as CharacteristicValue);
            expect(turnOn).toHaveBeenCalledTimes(1);
            expect(turnOff).not.toHaveBeenCalled();
        });
    });

    describe('status readback', () => {
        it('the On onGet handler reads the component status live, not the cached characteristic value', async () => {
            const { component, raw } = createFakeSwitchComponent();
            const { accessory } = createFakeAccessory();

            switchHelper(component, accessory, createFakeApi());

            const characteristic = onCharacteristicOf(accessory);
            const getHandler = characteristic.getHandler;
            ok(getHandler, 'expected the On onGet handler to be registered');

            expect(await getHandler()).toBe(false);

            // Flip the remote status without emitting state$: the read must come back live
            // while the characteristic's cached value stays untouched (no push happened).
            raw.status = true;
            expect(characteristic.value).toBeUndefined();
            expect(await getHandler()).toBe(true);
        });
    });

    describe('state$ subscription lifecycle', () => {
        it('stays subscribed after the helper returns and pushes remote state with updateValue', () => {
            const { component, raw, state } = createFakeSwitchComponent();
            const { accessory } = createFakeAccessory();

            switchHelper(component, accessory, createFakeApi());

            const characteristic = onCharacteristicOf(accessory);

            raw.status = true;
            state.next({});
            expect(characteristic.value).toBe(true);

            raw.status = false;
            state.next({});
            expect(characteristic.value).toBe(false);
        });

        it('a device push lands via updateValue and never re-enters onSet, echo or not', async () => {
            const { component, raw, state, turnOn, turnOff } = createFakeSwitchComponent();
            const { accessory } = createFakeAccessory();

            switchHelper(component, accessory, createFakeApi());

            const characteristic = onCharacteristicOf(accessory);

            raw.status = true;
            state.next({});
            expect(characteristic.value).toBe(true);
            await flush(); // let a wrong setValue re-entry (if ever introduced) settle
            // The push is silent regardless of whether the value matches the component status.
            expect(turnOn).not.toHaveBeenCalled();
            expect(turnOff).not.toHaveBeenCalled();
        });
    });
});
