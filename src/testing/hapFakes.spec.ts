import { describe, expect, it } from 'vitest';
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

describe('makeFakeCharacteristicClass', () => {
    it('exposes the uuid on static and instance and keeps value state', () => {
        expect(LIGHT_CHARACTERISTIC.UUID).toBe('light-uuid');
        const characteristic = new LIGHT_CHARACTERISTIC();
        expect(characteristic.UUID).toBe('light-uuid');
        characteristic.setValue(42);
        expect(characteristic.value).toBe(42);
        characteristic.updateValue(0.5);
        expect(characteristic.value).toBe(0.5);

        const initial = new LIGHT_CHARACTERISTIC(3);
        expect(initial.value).toBe(3);
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
            const nameCharacteristic = new NAME_CHARACTERISTIC('');

            const added = service.addCharacteristic(nameCharacteristic);

            expect(added).toBe(nameCharacteristic);
            expect(service.testCharacteristic(NAME_CHARACTERISTIC)).toBe(true);
            expect(service.autoAddedCharacteristics).toHaveLength(0);
            expect(added.value).toBe('');
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
