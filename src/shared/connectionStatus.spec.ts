import { describe, expect, it, vi } from 'vitest';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { Subject } from 'rxjs';

import { applyConnectionStatus, watchDeviceConnection } from './connectionStatus.js';

const STATUS_ACTIVE_UUID = 'status-active-uuid';
const ACCESSORY_INFORMATION_UUID = 'accessory-information-uuid';

class FakeStatusActive {
    public static readonly UUID = STATUS_ACTIVE_UUID;
    public readonly UUID = STATUS_ACTIVE_UUID;
    public value: boolean | undefined;

    public setValue(value: boolean): void {
        this.value = value;
    }

    /** Silent write, like real hap characteristics: updateValue never re-enters an onSet handler. */
    public updateValue(value: boolean): void {
        this.value = value;
    }
}

class FakeAccessoryInformation {
    public static readonly UUID = ACCESSORY_INFORMATION_UUID;
    public readonly UUID = ACCESSORY_INFORMATION_UUID;
}

interface FakeService extends FakeServiceShape {
    optionalCharacteristics: (typeof FakeStatusActive | typeof FakeAccessoryInformation)[];
    autoAddedCharacteristics: FakeStatusActive[];
}

/**
 * Faithful model of real hap-nodejs Service behavior:
 * - `testCharacteristic(constructor)` is a pure class-aware existence check (no side effects).
 * - `getCharacteristic(constructor)` auto-adds the characteristic when it is missing but
 *   listed among the service's optional characteristics (mirroring the real "silent" add).
 *   Anything else is returned as undefined — production code must not rely on auto-add.
 */
const makeFakeService = (
    optionalCharacteristics: (typeof FakeStatusActive | typeof FakeAccessoryInformation)[] = [],
    uuid = 'service-uuid',
) => {
    const service: FakeService = {
        UUID: uuid,
        characteristics: new Map(),
        optionalCharacteristics,
        autoAddedCharacteristics: [],
        testCharacteristic(constructor) {
            return service.characteristics.has(constructor.UUID);
        },
        getCharacteristic(constructor) {
            const existing = service.characteristics.get(constructor.UUID);
            if (existing) {
                return existing;
            }
            if (service.optionalCharacteristics.some((option) => option.UUID === constructor.UUID)) {
                const autoAdded = new (constructor as typeof FakeStatusActive)();
                service.characteristics.set(autoAdded.UUID, autoAdded);
                service.autoAddedCharacteristics.push(autoAdded);
                return autoAdded;
            }
            return undefined;
        },
        addCharacteristic(characteristic) {
            service.characteristics.set(characteristic.UUID, characteristic);
            return characteristic;
        },
    };
    return service;
};

interface FakeServiceShape {
    UUID: string;
    characteristics: Map<string, FakeStatusActive>;
    testCharacteristic: (constructor: typeof FakeStatusActive) => boolean;
    getCharacteristic: (
        constructor: typeof FakeStatusActive | typeof FakeAccessoryInformation,
    ) => FakeStatusActive | undefined;
    addCharacteristic: (characteristic: FakeStatusActive) => FakeStatusActive;
}

const createFakeApi = () =>
    ({
        hap: {
            Service: {
                AccessoryInformation: FakeAccessoryInformation,
            },
            Characteristic: {
                StatusActive: FakeStatusActive,
            },
        },
    }) as unknown as API;

const platformAccessoryWith = (...services: FakeService[]): PlatformAccessory =>
    ({ services }) as unknown as PlatformAccessory;

describe('applyConnectionStatus', () => {
    it('adds StatusActive where absent and sets it on every service of every accessory', () => {
        const api = createFakeApi();
        const sensorService = makeFakeService();
        const secondSensorService = makeFakeService();
        const accessory = platformAccessoryWith(sensorService, secondSensorService);

        applyConnectionStatus([accessory], false, api);

        for (const service of [sensorService, secondSensorService]) {
            const characteristic = service.characteristics.get(STATUS_ACTIVE_UUID);
            expect(characteristic).toBeInstanceOf(FakeStatusActive);
            expect(characteristic?.value).toBe(false);
        }
    });

    it('skips AccessoryInformation services entirely', () => {
        const api = createFakeApi();
        const infoService = makeFakeService([FakeAccessoryInformation], ACCESSORY_INFORMATION_UUID);
        const sensorService = makeFakeService();
        const accessory = platformAccessoryWith(infoService, sensorService);

        applyConnectionStatus([accessory], false, api);

        expect(infoService.testCharacteristic(FakeStatusActive)).toBe(false);
        expect(infoService.characteristics.has(STATUS_ACTIVE_UUID)).toBe(false);
        expect(sensorService.characteristics.get(STATUS_ACTIVE_UUID)?.value).toBe(false);
    });

    it('goes through testCharacteristic/addCharacteristic instead of relying on getCharacteristic auto-add', () => {
        const api = createFakeApi();
        const sensorService = makeFakeService();
        const addSpy = vi.spyOn(sensorService, 'addCharacteristic');
        const accessory = platformAccessoryWith(sensorService);

        applyConnectionStatus([accessory], false, api);

        // The characteristic must have been added explicitly (silent instance-form add),
        // never auto-added by getCharacteristic or fetched back from it as undefined.
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(sensorService.autoAddedCharacteristics).toHaveLength(0);
        expect(sensorService.characteristics.get(STATUS_ACTIVE_UUID)?.value).toBe(false);
    });

    it('adds no second characteristic when StatusActive already exists', () => {
        const api = createFakeApi();
        const sensorService = makeFakeService();
        const existing = new FakeStatusActive();
        sensorService.characteristics.set(STATUS_ACTIVE_UUID, existing);
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
        const alive$ = new Subject<boolean>();
        const sensorService = makeFakeService();
        const accessories: PlatformAccessory[] = [platformAccessoryWith(sensorService)];
        const onStateChange = vi.fn();

        const subscription = watchDeviceConnection('esp-device.local', { alive$ }, log as unknown as Logging, api, {
            accessoriesOfDevice: () => accessories,
            onStateChange,
        });

        return { subscription, alive$, log, sensorService, accessories, onStateChange };
    };

    it('applies buffered initial offline state without logging a false alarm', () => {
        // esphome-ts v4 buffers a `false` that every subscriber receives at subscribe time.
        const { alive$, log, sensorService, onStateChange } = setup();

        alive$.next(false);

        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
        expect(onStateChange).toHaveBeenCalledWith(false);
        expect(sensorService.characteristics.get(STATUS_ACTIVE_UUID)?.value).toBe(false);
    });

    it('logs a warning and marks all services inactive on connection loss after being connected', () => {
        const { alive$, log, sensorService, onStateChange } = setup();

        alive$.next(true); // first connection: state recorded, no log lines
        alive$.next(false);

        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('esp-device.local'));
        expect(log.info).not.toHaveBeenCalled();
        expect(sensorService.characteristics.get(STATUS_ACTIVE_UUID)?.value).toBe(false);
        expect(onStateChange).toHaveBeenNthCalledWith(2, false);
    });

    it('logs info and reactivates services on reconnect', () => {
        const { alive$, log, sensorService } = setup();

        alive$.next(true);
        alive$.next(false);
        alive$.next(true);

        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('re-established'));
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(sensorService.characteristics.get(STATUS_ACTIVE_UUID)?.value).toBe(true);
    });

    it('deduplicates consecutive identical states', () => {
        const { alive$, log, onStateChange } = setup();

        alive$.next(true);
        alive$.next(false);
        alive$.next(false);
        alive$.next(false);

        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(onStateChange).toHaveBeenCalledTimes(2);
    });

    it('re-evaluates the accessory lookup on every state change', () => {
        const { alive$, log, accessories, sensorService } = setup();

        // Device goes offline before its accessories were attached...
        accessories.splice(0, accessories.length);
        alive$.next(true);
        alive$.next(false);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(sensorService.testCharacteristic(FakeStatusActive)).toBe(false);

        // ...and comes back online after the accessories have been added.
        accessories.push(platformAccessoryWith(sensorService));
        alive$.next(true);
        expect(sensorService.characteristics.get(STATUS_ACTIVE_UUID)?.value).toBe(true);
    });
});

const createFakeLogging = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
});
