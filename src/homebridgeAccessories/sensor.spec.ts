import { describe, expect, it } from 'vitest';
import type { API, PlatformAccessory } from 'homebridge';
import { Subject } from 'rxjs';
import type { SensorComponent } from 'esphome-ts';

import { sensorHelper } from './sensor.js';
import { assertCharacteristic, makeFakeCharacteristicClass, makeFakeServiceClass } from '../testing/hapFakes.js';
import type { FakeHapService } from '../testing/hapFakes.js';

const CurrentTemperatureCharacteristic = makeFakeCharacteristicClass('current-temperature');
const CurrentRelativeHumidityCharacteristic = makeFakeCharacteristicClass('current-relative-humidity');
const CurrentAmbientLightLevelCharacteristic = makeFakeCharacteristicClass('current-ambient-light-level');

const TemperatureSensorService = makeFakeServiceClass('temperature-service-uuid', [CurrentTemperatureCharacteristic]);
const HumiditySensorService = makeFakeServiceClass('humidity-service-uuid', [CurrentRelativeHumidityCharacteristic]);
const LightSensorService = makeFakeServiceClass('light-sensor-service-uuid', [CurrentAmbientLightLevelCharacteristic]);

const ServiceClass = {
    TemperatureSensor: TemperatureSensorService,
    HumiditySensor: HumiditySensorService,
    LightSensor: LightSensorService,
};

const CharacteristicClass = {
    CurrentTemperature: CurrentTemperatureCharacteristic,
    CurrentRelativeHumidity: CurrentRelativeHumidityCharacteristic,
    CurrentAmbientLightLevel: CurrentAmbientLightLevelCharacteristic,
};

const createFakeApi = () =>
    ({
        hap: { Service: ServiceClass, Characteristic: CharacteristicClass },
    }) as unknown as API;

const createFakeAccessory = () => {
    const context = { services: [] as FakeHapService[] };
    const accessory = {
        services: context.services,
        addService(service: FakeHapService): FakeHapService {
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
        expect(context.services[0]).toHaveProperty('UUID', 'light-sensor-service-uuid');

        raw.value = 123.45;
        state$.next({});
        expect(assertCharacteristic(context.services[0], CurrentAmbientLightLevelCharacteristic).value).toBe(123.45);
    });

    it('maps an illuminance deviceClass onto the LightSensor as well', () => {
        const { component, raw, state$ } = createFakeSensorComponent({ deviceClass: 'illuminance' });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBe(true);
        expect(context.services[0]).toHaveProperty('UUID', 'light-sensor-service-uuid');

        raw.value = 42;
        state$.next({});
        expect(assertCharacteristic(context.services[0], CurrentAmbientLightLevelCharacteristic).value).toBe(42);
    });

    it('clamps out-of-range lux into the valid characteristic range', () => {
        const zeroLux = createFakeSensorComponent();
        const zeroAccessory = createFakeAccessory();
        sensorHelper(zeroLux.component, zeroAccessory.accessory, createFakeApi());
        zeroLux.raw.value = 0;
        zeroLux.state$.next({});
        expect(
            assertCharacteristic(zeroAccessory.context.services[0], CurrentAmbientLightLevelCharacteristic).value,
        ).toBe(0.0001);

        const negativeLux = createFakeSensorComponent();
        const negativeAccessory = createFakeAccessory();
        sensorHelper(negativeLux.component, negativeAccessory.accessory, createFakeApi());
        negativeLux.raw.value = -5;
        negativeLux.state$.next({});
        expect(
            assertCharacteristic(negativeAccessory.context.services[0], CurrentAmbientLightLevelCharacteristic).value,
        ).toBe(0.0001);

        const blindingLux = createFakeSensorComponent();
        const blindingAccessory = createFakeAccessory();
        sensorHelper(blindingLux.component, blindingAccessory.accessory, createFakeApi());
        blindingLux.raw.value = 999_999;
        blindingLux.state$.next({});
        expect(
            assertCharacteristic(blindingAccessory.context.services[0], CurrentAmbientLightLevelCharacteristic).value,
        ).toBe(100_000);
    });

    it('skips pushing while no measurement is available', () => {
        const { component, state$ } = createFakeSensorComponent();
        const { accessory, context } = createFakeAccessory();

        sensorHelper(component, accessory, createFakeApi());
        state$.next({});

        expect(assertCharacteristic(context.services[0], CurrentAmbientLightLevelCharacteristic).value).toBeUndefined();
    });

    it('keeps the fahrenheit temperature path intact', () => {
        const { component, raw, state$ } = createFakeSensorComponent({ unitOfMeasurement: '°F' });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBe(true);
        expect(context.services[0]).toHaveProperty('UUID', 'temperature-service-uuid');

        raw.value = 68;
        state$.next({});
        // (68 - 32) * 5 / 9 = 20 °C
        expect(assertCharacteristic(context.services[0], CurrentTemperatureCharacteristic).value).toBeCloseTo(20);
    });
});
