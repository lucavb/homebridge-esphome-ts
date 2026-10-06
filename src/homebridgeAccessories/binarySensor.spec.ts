import { describe, expect, it, vi } from 'vitest';
import type { API } from 'homebridge';
import { BehaviorSubject, filter } from 'rxjs';
import { BinarySensorComponent, BinarySensorTypes } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { binarySensorHelper } from './binarySensor.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    type FakeHapCharacteristic,
} from '../testing/hapFakes.js';

const MOTION_CHARACTERISTIC = makeFakeCharacteristicClass('motion-detected-uuid');
const CONTACT_CHARACTERISTIC = makeFakeCharacteristicClass('contact-sensor-state-uuid');

const MotionSensorService = makeFakeServiceClass('motion-sensor-uuid', [MOTION_CHARACTERISTIC]);
const ContactSensorService = makeFakeServiceClass('contact-sensor-uuid', [CONTACT_CHARACTERISTIC]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { MotionSensor: MotionSensorService, ContactSensor: ContactSensorService },
            Characteristic: { MotionDetected: MOTION_CHARACTERISTIC, ContactSensorState: CONTACT_CHARACTERISTIC },
        },
    }) as unknown as API;

const createFakeBinarySensorComponent = (deviceClass: BinarySensorTypes) => {
    /**
     * Faithful to esphome-ts v5 state$: built from a BehaviorSubject(undefined) filtered on
     * undefined, so late subscribers (each binding row) get the current state replayed at
     * subscribe time (esphome-ts dist/index.js:2837, 2819-2826). v5 shallow-compare dedup drops
     * identical re-sent states upstream of the contract this fake models.
     */
    const state = new BehaviorSubject<unknown>(undefined);
    const state$ = state.pipe(filter((value) => value !== undefined));
    const fields = {
        name: 'TestBinarySensor',
        deviceClass,
        status: false,
        state$,
    };
    /**
     * Boundary fake: sits on the real BinarySensorComponent.prototype (the helper narrows
     * with instanceof) and shadows the getters with live fields the spec can mutate.
     */
    const component = Object.create(BinarySensorComponent.prototype) as BinarySensorComponent;
    for (const key of Object.keys(fields)) {
        Object.defineProperty(component, key, { enumerable: true, get: () => fields[key as keyof typeof fields] });
    }
    return { component, raw: fields, state };
};

/** Invokes the stored onGet handler, failing loudly when none is registered. */
const invokeGet = async (characteristic: FakeHapCharacteristic): Promise<unknown> => {
    const handler = characteristic.getHandler;
    ok(handler, 'expected the read handler to be registered');
    return await handler();
};

describe('binarySensorHelper', () => {
    it('maps a deviceClass onto its service and characteristic and wires read + push', async () => {
        const { component, raw, state } = createFakeBinarySensorComponent(BinarySensorTypes.MOTION);
        const { accessory, context } = createFakeAccessory();

        const teardown = binarySensorHelper(component, accessory, createFakeApi());
        expect(teardown).toBeTypeOf('function');

        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'motion-sensor-uuid');
        expect(context.services[0]).toHaveProperty('name', 'TestBinarySensor');

        const characteristic = assertCharacteristic(context.services[0], MOTION_CHARACTERISTIC);
        // read returns the live component status through onGet before any push
        expect(characteristic.getHandler).toBeTypeOf('function');
        expect(await invokeGet(characteristic)).toBe(false);

        raw.status = true;
        state.next({});
        expect(characteristic.value).toBe(true);
    });

    it('shares the ContactSensor table entry across window and door deviceClasses', () => {
        const windowSensor = createFakeBinarySensorComponent(BinarySensorTypes.WINDOW);
        const windowAccessory = createFakeAccessory();
        binarySensorHelper(windowSensor.component, windowAccessory.accessory, createFakeApi());
        expect(windowAccessory.context.services).toHaveLength(1);
        expect(windowAccessory.context.services[0]).toHaveProperty('UUID', 'contact-sensor-uuid');

        const doorSensor = createFakeBinarySensorComponent(BinarySensorTypes.DOOR);
        const doorAccessory = createFakeAccessory();
        binarySensorHelper(doorSensor.component, doorAccessory.accessory, createFakeApi());
        expect(doorAccessory.context.services).toHaveLength(1);
        expect(doorAccessory.context.services[0]).toHaveProperty('UUID', 'contact-sensor-uuid');
    });

    it('reuses an existing mapped service instead of adding one', () => {
        const { component } = createFakeBinarySensorComponent(BinarySensorTypes.MOTION);
        const existing = new MotionSensorService('TestBinarySensor');
        const { accessory, context } = createFakeAccessory();
        context.services.push(existing);
        const addSpy = vi.spyOn(accessory, 'addService');

        binarySensorHelper(component, accessory, createFakeApi());

        expect(addSpy).not.toHaveBeenCalled();
        expect(context.services).toHaveLength(1);
    });

    it('returns undefined for an unmapped deviceClass without touching the accessory', () => {
        const { component } = createFakeBinarySensorComponent(BinarySensorTypes.OCCUPANCY);
        const { accessory, context } = createFakeAccessory();

        expect(binarySensorHelper(component, accessory, createFakeApi())).toBeUndefined();
        expect(context.services).toHaveLength(0);
    });

    it('stops pushing state after teardown', () => {
        const { component, raw, state } = createFakeBinarySensorComponent(BinarySensorTypes.MOTION);
        const { accessory, context } = createFakeAccessory();

        const teardown = binarySensorHelper(component, accessory, createFakeApi());
        const characteristic = assertCharacteristic(context.services[0], MOTION_CHARACTERISTIC);

        teardown?.();
        raw.status = true;
        state.next({});
        expect(characteristic.value).toBeUndefined();
    });
});
