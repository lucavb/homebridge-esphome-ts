import { describe, expect, it, vi } from 'vitest';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { BehaviorSubject, distinctUntilChanged, shareReplay } from 'rxjs';

import { applyConnectionStatus, watchDeviceConnection } from './connectionStatus.js';
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

const createFakeLogging = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
});

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

describe('watchDeviceConnection', () => {
    const setup = () => {
        const log = createFakeLogging();
        const api = createFakeApi();
        // Faithful to esphome-ts v4: alive$ is distinctUntilChanged + shareReplay(1) over a merge whose
        // connected$ source is a BehaviorSubject(false) — every subscriber synchronously receives the
        // buffered false at subscribe time (esphome-ts dist/index.js:2494, 3277-3281).
        const connected = new BehaviorSubject<boolean>(false);
        const alive$ = connected.pipe(distinctUntilChanged(), shareReplay(1));
        const sensorService = new SensorService();
        const accessories: PlatformAccessory[] = [platformAccessoryWith(sensorService)];
        const onStateChange = vi.fn();

        const subscription = watchDeviceConnection('esp-device.local', { alive$ }, log as unknown as Logging, api, {
            accessoriesOfDevice: () => accessories,
            onStateChange,
        });

        return { subscription, connected, alive$, log, sensorService, accessories, onStateChange };
    };

    it('applies buffered initial offline state without logging a false alarm', () => {
        // No manual push: the buffered `false` arrives on its own at subscribe time.
        const { connected, log, sensorService, onStateChange } = setup();

        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
        expect(onStateChange).toHaveBeenCalledWith(false);
        expect(assertCharacteristic(sensorService, StatusActiveCharacteristic).value).toBe(false);

        // distinctUntilChanged dedupes a repeated offline emission into the buffered one.
        connected.next(false);
        expect(onStateChange).toHaveBeenCalledTimes(1);
    });

    it('logs a warning and marks all services inactive on connection loss after being connected', () => {
        const { connected, log, sensorService, onStateChange } = setup();

        connected.next(true); // first connection: state recorded, no log lines
        connected.next(false);

        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('esp-device.local'));
        expect(log.info).not.toHaveBeenCalled();
        expect(assertCharacteristic(sensorService, StatusActiveCharacteristic).value).toBe(false);
        // buffered false (n=1), true (n=2), false (n=3)
        expect(onStateChange).toHaveBeenNthCalledWith(3, false);
    });

    it('logs info and reactivates services on reconnect', () => {
        const { connected, log, sensorService } = setup();

        connected.next(true);
        connected.next(false);
        connected.next(true);

        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('re-established'));
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(assertCharacteristic(sensorService, StatusActiveCharacteristic).value).toBe(true);
    });

    it('deduplicates consecutive identical states', () => {
        const { connected, log, onStateChange } = setup();

        connected.next(true);
        connected.next(false);
        connected.next(false);
        connected.next(false);

        expect(log.warn).toHaveBeenCalledTimes(1);
        // buffered false + true + false — the repeated falses are deduplicated.
        expect(onStateChange).toHaveBeenCalledTimes(3);
    });

    it('re-evaluates the accessory lookup on every state change', () => {
        const { connected, log, accessories } = setup();

        // Device goes offline with no accessories attached...
        accessories.splice(0, accessories.length);
        connected.next(true);
        connected.next(false);
        expect(log.warn).toHaveBeenCalledTimes(1);

        // ...and comes back online after a NEW accessory has been added late: the lookup is
        // re-evaluated per state change, so the late service gets its StatusActive written.
        const lateService = new SensorService();
        accessories.push(platformAccessoryWith(lateService));
        connected.next(true);

        expect(lateService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(lateService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });
});
