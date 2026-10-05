import { describe, expect, it, vi } from 'vitest';
import type { Service } from 'homebridge';

import {
    assertCharacteristic,
    createFakeAccessory,
    FakeHapStatusError,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    platformAccessoryWith,
} from './hapFakes.js';

const LIGHT_CHARACTERISTIC = makeFakeCharacteristicClass('light-uuid');
const ON_CHARACTERISTIC = makeFakeCharacteristicClass('on-uuid');
const NAME_CHARACTERISTIC = makeFakeCharacteristicClass('name-uuid');
const UNUSED_CHARACTERISTIC = makeFakeCharacteristicClass('unused-uuid');

const SwitchService = makeFakeServiceClass('switch-service-uuid', [ON_CHARACTERISTIC]);

/** Lets an async setValue handler chain (assign-on-resolve) settle before asserting effects. */
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('makeFakeCharacteristicClass', () => {
    it('exposes the uuid on static and instance and keeps value state', () => {
        expect(LIGHT_CHARACTERISTIC.UUID).toBe('light-uuid');
        const characteristic = new LIGHT_CHARACTERISTIC();
        expect(characteristic.UUID).toBe('light-uuid');
        characteristic.setValue(42);
        expect(characteristic.value).toBe(42);
        characteristic.updateValue(0.5);
        expect(characteristic.value).toBe(0.5);
    });

    it('starts with the no-write sentinel: value reads undefined when nobody wrote (deliberate divergence from real hap getDefaultValue)', () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        expect(characteristic.value).toBeUndefined();
    });

    it('stores onSet/onGet handlers and returns the characteristic for chaining', () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        const setHandler = vi.fn();
        const getHandler = vi.fn(() => 5);

        expect(characteristic.onSet(setHandler)).toBe(characteristic);
        expect(characteristic.onGet(getHandler)).toBe(characteristic);
        expect(characteristic.setHandler).toBe(setHandler);
        expect(characteristic.getHandler).toBe(getHandler);
        expect(characteristic.getHandler?.()).toBe(5);
    });

    it('re-enters the stored onSet handler on setValue and stores only after it resolves', async () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        const resolvingHandler = vi.fn(async () => undefined);
        characteristic.onSet(resolvingHandler);

        characteristic.setValue(7);

        // Assign-on-resolve (Characteristic.js:1804-1833): nothing stored while the chain is pending.
        expect(resolvingHandler).toHaveBeenCalledWith(7);
        expect(characteristic.value).toBeUndefined();

        await flush();
        expect(characteristic.value).toBe(7);
    });

    it('re-enters the stored onSet handler on setValue; a rejection is swallowed and the value is not stored', async () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        const rejectingHandler = vi.fn(() => Promise.reject(new Error('device gone')));
        characteristic.onSet(rejectingHandler);

        expect(() => characteristic.setValue(7)).not.toThrow();

        await vi.waitFor(() => expect(rejectingHandler).toHaveBeenCalledWith(7));
        // stays at its prior (sentinel) state
        expect(characteristic.value).toBeUndefined();
    });

    it('swallows a synchronously throwing onSet handler on setValue re-entry and does not store the value', async () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        const throwingHandler = vi.fn(() => {
            throw new Error('device gone');
        });
        characteristic.onSet(throwingHandler);

        expect(() => characteristic.setValue(9)).not.toThrow();

        expect(throwingHandler).toHaveBeenCalledWith(9);
        // stays at its prior (sentinel) state
        expect(characteristic.value).toBeUndefined();
    });

    it('stores the value synchronously when no onSet handler is registered', () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        characteristic.setValue(11);
        expect(characteristic.value).toBe(11);
    });

    it('updateValue skips the onSet handler', async () => {
        const characteristic = new LIGHT_CHARACTERISTIC();
        const setHandler = vi.fn();
        characteristic.onSet(setHandler);

        characteristic.updateValue(0.5);

        expect(characteristic.value).toBe(0.5);
        expect(setHandler).not.toHaveBeenCalled();
    });
});

describe('makeFakeServiceClass', () => {
    it('pre-creates mandatory characteristics on construction, like real hap services', () => {
        const service = new SwitchService('entry light', '');
        expect(service.UUID).toBe('switch-service-uuid');
        expect(service.name).toBe('entry light');
        expect(service.subtype).toBe('');
        expect(service.testCharacteristic(ON_CHARACTERISTIC)).toBe(true);
        expect(service.autoAddedCharacteristics).toHaveLength(0);
        expect(service.autoAddedUnlistedCharacteristics).toHaveLength(0);
    });

    describe('testCharacteristic', () => {
        it('is a pure existence check with no side effects', () => {
            const service = new SwitchService('entry light');
            const before = service.characteristics.size;

            const absent = service.testCharacteristic(LIGHT_CHARACTERISTIC);
            const present = service.testCharacteristic(ON_CHARACTERISTIC);

            expect(absent).toBe(false);
            expect(present).toBe(true);
            expect(service.characteristics.size).toBe(before);
            expect(service.autoAddedCharacteristics).toHaveLength(0);
            expect(service.autoAddedUnlistedCharacteristics).toHaveLength(0);
        });
    });

    describe('getCharacteristic', () => {
        it('returns mandatory characteristics without any auto-add', () => {
            const service = new SwitchService('entry light');

            const on = assertCharacteristic(service, ON_CHARACTERISTIC);

            expect(on.value).toBeUndefined();
            expect(service.autoAddedCharacteristics).toHaveLength(0);
            expect(service.autoAddedUnlistedCharacteristics).toHaveLength(0);
        });

        it('auto-adds optional characteristics silently and tracks the additions', () => {
            const service = new SwitchService('entry light');
            service.optionalCharacteristics = [LIGHT_CHARACTERISTIC];

            const autoAdded = service.getCharacteristic(LIGHT_CHARACTERISTIC);

            expect(autoAdded.UUID).toBe('light-uuid');
            expect(service.autoAddedCharacteristics).toHaveLength(1);
            expect(service.autoAddedCharacteristics[0]).toBe(autoAdded);
            expect(service.testCharacteristic(LIGHT_CHARACTERISTIC)).toBe(true);

            // A second lookup must return the tracked instance, not trigger a second add.
            expect(service.getCharacteristic(LIGHT_CHARACTERISTIC)).toBe(autoAdded);
            expect(service.autoAddedCharacteristics).toHaveLength(1);
        });

        it('auto-adds unlisted characteristics as well and tracks them separately (real hap warns there; the fake is silent)', () => {
            const service = new SwitchService('entry light');

            const autoAdded = service.getCharacteristic(UNUSED_CHARACTERISTIC);

            // never undefined: real hap always hands back a characteristic
            expect(autoAdded.UUID).toBe('unused-uuid');
            expect(service.testCharacteristic(UNUSED_CHARACTERISTIC)).toBe(true);
            expect(service.autoAddedUnlistedCharacteristics).toHaveLength(1);
            expect(service.autoAddedUnlistedCharacteristics[0]).toBe(autoAdded);
            expect(service.autoAddedCharacteristics).toHaveLength(0);

            // A second lookup must return the tracked instance, not trigger a second add.
            expect(service.getCharacteristic(UNUSED_CHARACTERISTIC)).toBe(autoAdded);
            expect(service.autoAddedUnlistedCharacteristics).toHaveLength(1);
        });
    });

    describe('addCharacteristic', () => {
        it('adds the given instance silently and makes it findable', () => {
            const service = new SwitchService('entry light');
            const nameCharacteristic = new NAME_CHARACTERISTIC();

            const added = service.addCharacteristic(nameCharacteristic);

            expect(added).toBe(nameCharacteristic);
            expect(service.testCharacteristic(NAME_CHARACTERISTIC)).toBe(true);
            expect(service.autoAddedCharacteristics).toHaveLength(0);
            // no-arg construction default-initializes the value, like real concrete classes
            expect(added.value).toBeUndefined();
        });
    });
});

describe('platformAccessoryWith', () => {
    it('builds an accessory-shaped object exposing its services', () => {
        const serviceOne = new SwitchService('a');
        const serviceTwo = new SwitchService('b');
        const accessory = platformAccessoryWith(serviceOne, serviceTwo);
        expect(accessory.services).toEqual([serviceOne, serviceTwo]);
    });
});

describe('FakeHapStatusError', () => {
    it('is an Error storing the hapStatus code it was constructed with', () => {
        const error = new FakeHapStatusError('SERVICE_COMMUNICATION_FAILURE');
        expect(error).toBeInstanceOf(Error);
        expect(error.hapStatus).toBe('SERVICE_COMMUNICATION_FAILURE');
        expect(error.message).toContain('SERVICE_COMMUNICATION_FAILURE');
    });
});

describe('createFakeAccessory', () => {
    it('starts with empty services and collects those added via addService', () => {
        const { accessory, context } = createFakeAccessory();
        expect(context.services).toHaveLength(0);
        expect(accessory.services).toHaveLength(0);

        const service = new SwitchService('added');
        // Boundary cast: addService is typed against the real PlatformAccessory surface.
        expect(accessory.addService(service as unknown as Service)).toBe(service);
        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toBe(service);
        expect(accessory.services).toEqual([service]);
    });

    it('exposes pre-existing services in context and on the accessory', () => {
        const existing = new SwitchService('existing');
        const { accessory, context } = createFakeAccessory(existing);
        expect(context.services).toEqual([existing]);
        expect(accessory.services).toEqual([existing]);
    });
});
