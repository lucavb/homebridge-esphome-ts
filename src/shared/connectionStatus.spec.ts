import { describe, expect, it, vi } from 'vitest';
import type { API } from 'homebridge';

import { applyConnectionStatus } from './connectionStatus.js';
import {
    assertCharacteristic,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    platformAccessoryWith,
} from '../testing/hapFakes.js';

const StatusActiveCharacteristic = makeFakeCharacteristicClass('status-active-uuid');
const AccessoryInformationService = makeFakeServiceClass('accessory-information-uuid');

const ServiceClass = {
    AccessoryInformation: AccessoryInformationService,
};

const CharacteristicClass = {
    StatusActive: StatusActiveCharacteristic,
};

const SensorService = makeFakeServiceClass('sensor-service-uuid');
const SecondFakeSensorService = makeFakeServiceClass('second-service-uuid');

const createFakeApi = () =>
    ({
        hap: { Service: ServiceClass, Characteristic: CharacteristicClass },
    }) as unknown as API;

describe('applyConnectionStatus', () => {
    it('adds StatusActive where absent and sets it on every service of every accessory', () => {
        const api = createFakeApi();
        const sensorService = new SensorService();
        const secondSensorService = new SecondFakeSensorService();
        const accessory = platformAccessoryWith(sensorService, secondSensorService);

        applyConnectionStatus([accessory], false, api);

        for (const service of [sensorService, secondSensorService]) {
            const characteristic = assertCharacteristic(service, StatusActiveCharacteristic);
            expect(characteristic.value).toBe(false);
        }
    });

    it('skips AccessoryInformation services entirely', () => {
        const api = createFakeApi();
        const infoService = new AccessoryInformationService('info');
        const sensorService = new SensorService();
        const accessory = platformAccessoryWith(infoService, sensorService);

        applyConnectionStatus([accessory], false, api);

        expect(infoService.testCharacteristic(StatusActiveCharacteristic)).toBe(false);
        expect(infoService.characteristics.has('status-active-uuid')).toBe(false);
        expect(assertCharacteristic(sensorService, StatusActiveCharacteristic).value).toBe(false);
    });

    it('goes through testCharacteristic/addCharacteristic instead of relying on getCharacteristic auto-add', () => {
        const api = createFakeApi();
        const sensorService = new SensorService();
        const addSpy = vi.spyOn(sensorService, 'addCharacteristic');
        const accessory = platformAccessoryWith(sensorService);

        applyConnectionStatus([accessory], false, api);

        // The characteristic must have been added explicitly (silent instance-form add),
        // never auto-added by getCharacteristic or fetched back from it as undefined.
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(sensorService.autoAddedCharacteristics).toHaveLength(0);
        expect(assertCharacteristic(sensorService, StatusActiveCharacteristic).value).toBe(false);
    });

    it('adds no second characteristic when StatusActive already exists', () => {
        const api = createFakeApi();
        const sensorService = new SensorService();
        const existing = new StatusActiveCharacteristic();
        sensorService.addCharacteristic(existing);
        const addSpy = vi.spyOn(sensorService, 'addCharacteristic');
        const accessory = platformAccessoryWith(sensorService);

        applyConnectionStatus([accessory], true, api);

        expect(addSpy).not.toHaveBeenCalled();
        expect(sensorService.autoAddedCharacteristics).toHaveLength(0);
        expect(existing.value).toBe(true);
    });

    it('works with an empty accessory list', () => {
        expect(() => applyConnectionStatus([], true, createFakeApi())).not.toThrow();
    });
});
