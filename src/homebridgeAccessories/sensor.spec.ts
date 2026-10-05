import { describe, expect, it } from 'vitest';
import type { API, PlatformAccessory } from 'homebridge';
import { Subject } from 'rxjs';
import type { SensorComponent } from 'esphome-ts';

import { sensorHelper } from './sensor.js';

interface FakeCharacteristic {
    value: number | undefined;
    setValue: (value: number) => void;
    updateValue: (value: number) => void;
}

const createFakeCharacteristic = (): FakeCharacteristic => {
    const characteristic: FakeCharacteristic & Record<string, unknown> = {
        value: undefined,
        setValue(value) {
            characteristic.value = value;
        },
        updateValue(value) {
            characteristic.value = value;
        },
    };
    return characteristic;
};

interface FakeServiceInstance {
    UUID: string;
    characteristics: Map<string, FakeCharacteristic>;
    getCharacteristic: (key: string) => FakeCharacteristic | undefined;
}

/** Runtime stand-in for `api.hap.Service` (a namespace object whose props are service constructor classes). */
const makeFakeServiceClass = (uuid: string, characteristicKeys: string[]) => {
    class FakeService implements FakeServiceInstance {
        public static readonly UUID = uuid;
        public readonly UUID = uuid;
        public readonly name: string;
        public readonly subtype: string;
        public readonly characteristics: Map<string, FakeCharacteristic>;

        public constructor(name: string, subtype: string) {
            this.name = name;
            this.subtype = subtype;
            // Real hap-nodejs services expose their mandatory characteristics right after creation.
            this.characteristics = new Map(characteristicKeys.map((key) => [key, createFakeCharacteristic()]));
        }

        public getCharacteristic(key: string): FakeCharacteristic | undefined {
            return this.characteristics.get(key);
        }
    }
    return FakeService;
};

const TEMPERATURE_SERVICE_UUID = 'temperature-service-uuid';
const HUMIDITY_SERVICE_UUID = 'humidity-service-uuid';
const LIGHT_SENSOR_SERVICE_UUID = 'light-sensor-service-uuid';
const TEMP_CHARACTERISTIC_KEY = 'current-temperature';
const HUMIDITY_CHARACTERISTIC_KEY = 'current-relative-humidity';
const AMBIENT_LIGHT_CHARACTERISTIC_KEY = 'current-ambient-light-level';

const ServiceClass = {
    TemperatureSensor: makeFakeServiceClass(TEMPERATURE_SERVICE_UUID, [TEMP_CHARACTERISTIC_KEY]),
    HumiditySensor: makeFakeServiceClass(HUMIDITY_SERVICE_UUID, [HUMIDITY_CHARACTERISTIC_KEY]),
    LightSensor: makeFakeServiceClass(LIGHT_SENSOR_SERVICE_UUID, [AMBIENT_LIGHT_CHARACTERISTIC_KEY]),
};

const CharacteristicClass = {
    CurrentTemperature: TEMP_CHARACTERISTIC_KEY,
    CurrentRelativeHumidity: HUMIDITY_CHARACTERISTIC_KEY,
    CurrentAmbientLightLevel: AMBIENT_LIGHT_CHARACTERISTIC_KEY,
};

const createFakeApi = () =>
    ({
        hap: { Service: ServiceClass, Characteristic: CharacteristicClass },
    }) as unknown as API;

const createFakeAccessory = () => {
    const context = { services: [] as FakeServiceInstance[] };
    const accessory = {
        services: context.services,
        addService(service: FakeServiceInstance): FakeServiceInstance {
            context.services.push(service);
            return service;
        },
    } as unknown as PlatformAccessory;
    return { accessory, context };
};

const createFakeSensorComponent = (
    overrides: Partial<Record<'unitOfMeasurement' | 'deviceClass' | 'icon', string>> = {},
) => {
    const state$ = new Subject<unknown>();
    const raw = {
        name: 'test sensor',
        unitOfMeasurement: 'lx',
        deviceClass: undefined as string | undefined,
        icon: 'mdi:brightness-5',
        value: undefined as number | undefined,
        state$,
        ...overrides,
    };
    return {
        component: raw as unknown as SensorComponent,
        raw,
        state$,
    };
};

/** Returns the characteristic that received pushes for the given key. */
const characteristicOf = (services: FakeServiceInstance[], key: string): FakeCharacteristic => {
    const characteristic = services[0]?.characteristics.get(key);
    if (!characteristic) {
        throw new Error(`characteristic ${key} not found`);
    }
    return characteristic;
};

describe('sensorHelper', () => {
    it('returns false for unsupported sensors', () => {
        const { component } = createFakeSensorComponent({ unitOfMeasurement: 'V' });
        const { accessory } = createFakeAccessory();
        expect(sensorHelper(component, accessory, createFakeApi())).toBe(false);
    });

    it('adds a LightSensor service for a lux sensor and pushes measured values', () => {
        const { component, raw, state$ } = createFakeSensorComponent();
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBe(true);

        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', LIGHT_SENSOR_SERVICE_UUID);

        raw.value = 123.45;
        state$.next({});
        expect(characteristicOf(context.services, AMBIENT_LIGHT_CHARACTERISTIC_KEY).value).toBe(123.45);
    });

    it('maps an illuminance deviceClass onto the LightSensor as well', () => {
        const { component, raw, state$ } = createFakeSensorComponent({ deviceClass: 'illuminance' });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBe(true);
        expect(context.services[0]).toHaveProperty('UUID', LIGHT_SENSOR_SERVICE_UUID);

        raw.value = 42;
        state$.next({});
        expect(characteristicOf(context.services, AMBIENT_LIGHT_CHARACTERISTIC_KEY).value).toBe(42);
    });

    it('clamps out-of-range lux into the valid characteristic range', () => {
        const zeroLux = createFakeSensorComponent();
        const zeroContext = createFakeAccessory();
        sensorHelper(zeroLux.component, zeroContext.accessory, createFakeApi());
        zeroLux.raw.value = 0;
        zeroLux.state$.next({});
        expect(characteristicOf(zeroContext.context.services, AMBIENT_LIGHT_CHARACTERISTIC_KEY).value).toBe(0.0001);

        const negativeLux = createFakeSensorComponent();
        const negativeContext = createFakeAccessory();
        sensorHelper(negativeLux.component, negativeContext.accessory, createFakeApi());
        negativeLux.raw.value = -5;
        negativeLux.state$.next({});
        expect(characteristicOf(negativeContext.context.services, AMBIENT_LIGHT_CHARACTERISTIC_KEY).value).toBe(0.0001);

        const blindingLux = createFakeSensorComponent();
        const blindingContext = createFakeAccessory();
        sensorHelper(blindingLux.component, blindingContext.accessory, createFakeApi());
        blindingLux.raw.value = 999_999;
        blindingLux.state$.next({});
        expect(characteristicOf(blindingContext.context.services, AMBIENT_LIGHT_CHARACTERISTIC_KEY).value).toBe(
            100_000,
        );
    });

    it('skips pushing while no measurement is available', () => {
        const { component, state$ } = createFakeSensorComponent();
        const { accessory, context } = createFakeAccessory();

        sensorHelper(component, accessory, createFakeApi());
        state$.next({});

        expect(characteristicOf(context.services, AMBIENT_LIGHT_CHARACTERISTIC_KEY).value).toBeUndefined();
    });

    it('keeps the fahrenheit temperature path intact', () => {
        const { component, raw, state$ } = createFakeSensorComponent({ unitOfMeasurement: '°F' });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBe(true);
        expect(context.services[0]).toHaveProperty('UUID', TEMPERATURE_SERVICE_UUID);

        raw.value = 68;
        state$.next({});
        // (68 - 32) * 5 / 9 = 20 °C
        expect(characteristicOf(context.services, TEMP_CHARACTERISTIC_KEY).value).toBeCloseTo(20);
    });
});
