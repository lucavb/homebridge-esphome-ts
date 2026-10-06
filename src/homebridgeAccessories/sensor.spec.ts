import { describe, expect, it } from 'vitest';
import type { API } from 'homebridge';
import { BehaviorSubject, filter } from 'rxjs';
import { SensorComponent } from 'esphome-ts';

import { sensorHelper } from './sensor.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
} from '../testing/hapFakes.js';

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

const createFakeSensorComponent = (
    overrides: Partial<Record<'unitOfMeasurement' | 'deviceClass' | 'icon' | 'name', string>> &
        Partial<Record<'value', number | undefined>> = {},
) => {
    /**
     * Faithful to esphome-ts v5 state$: built from a BehaviorSubject(undefined) filtered on
     * undefined, so late subscribers (each binding row) get the current state replayed at
     * subscribe time (esphome-ts dist/index.js:2837, 2819-2826). v5 shallow-compare dedup drops
     * identical re-sent states upstream of the contract this fake models.
     */
    const state = new BehaviorSubject<unknown>(undefined);
    const state$ = state.pipe(filter((value) => value !== undefined));
    const fields = {
        name: 'test sensor',
        unitOfMeasurement: 'lx',
        deviceClass: undefined as string | undefined,
        icon: 'mdi:brightness-5',
        value: undefined as number | undefined,
        state$,
        ...overrides,
    };
    /**
     * Boundary fake: sits on the real SensorComponent.prototype (the helper narrows with
     * instanceof) and shadows the getters with live fields the spec can mutate.
     */
    const component = Object.create(SensorComponent.prototype) as SensorComponent;
    for (const key of Object.keys(fields)) {
        Object.defineProperty(component, key, { enumerable: true, get: () => fields[key as keyof typeof fields] });
    }
    return {
        component,
        raw: fields,
        state,
    };
};

describe('sensorHelper', () => {
    it('returns undefined for unsupported sensors', () => {
        const { component } = createFakeSensorComponent({ unitOfMeasurement: 'V' });
        const { accessory } = createFakeAccessory();
        expect(sensorHelper(component, accessory, createFakeApi())).toBeUndefined();
    });

    it('adds a LightSensor service for a lux sensor and pushes measured values', () => {
        const { component, raw, state } = createFakeSensorComponent();
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBeTypeOf('function');

        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'light-sensor-service-uuid');

        raw.value = 123.45;
        state.next({});
        expect(assertCharacteristic(context.services[0], CurrentAmbientLightLevelCharacteristic).value).toBe(123.45);
    });

    it('maps an illuminance deviceClass onto the LightSensor as well', () => {
        const { component, raw, state } = createFakeSensorComponent({ deviceClass: 'illuminance' });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBeTypeOf('function');
        expect(context.services[0]).toHaveProperty('UUID', 'light-sensor-service-uuid');

        raw.value = 42;
        state.next({});
        expect(assertCharacteristic(context.services[0], CurrentAmbientLightLevelCharacteristic).value).toBe(42);
    });

    it('clamps out-of-range lux into the valid characteristic range', () => {
        const zeroLux = createFakeSensorComponent();
        const zeroAccessory = createFakeAccessory();
        sensorHelper(zeroLux.component, zeroAccessory.accessory, createFakeApi());
        zeroLux.raw.value = 0;
        zeroLux.state.next({});
        expect(
            assertCharacteristic(zeroAccessory.context.services[0], CurrentAmbientLightLevelCharacteristic).value,
        ).toBe(0.0001);

        const negativeLux = createFakeSensorComponent();
        const negativeAccessory = createFakeAccessory();
        sensorHelper(negativeLux.component, negativeAccessory.accessory, createFakeApi());
        negativeLux.raw.value = -5;
        negativeLux.state.next({});
        expect(
            assertCharacteristic(negativeAccessory.context.services[0], CurrentAmbientLightLevelCharacteristic).value,
        ).toBe(0.0001);

        const blindingLux = createFakeSensorComponent();
        const blindingAccessory = createFakeAccessory();
        sensorHelper(blindingLux.component, blindingAccessory.accessory, createFakeApi());
        blindingLux.raw.value = 999_999;
        blindingLux.state.next({});
        expect(
            assertCharacteristic(blindingAccessory.context.services[0], CurrentAmbientLightLevelCharacteristic).value,
        ).toBe(100_000);
    });

    it('skips pushing while no measurement is available', () => {
        const { component, state } = createFakeSensorComponent();
        const { accessory, context } = createFakeAccessory();

        sensorHelper(component, accessory, createFakeApi());
        state.next({});

        expect(assertCharacteristic(context.services[0], CurrentAmbientLightLevelCharacteristic).value).toBeUndefined();
    });

    it('keeps the fahrenheit temperature path intact', () => {
        const { component, raw, state } = createFakeSensorComponent({ unitOfMeasurement: '°F' });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBeTypeOf('function');
        expect(context.services[0]).toHaveProperty('UUID', 'temperature-service-uuid');

        raw.value = 68;
        state.next({});
        // (68 - 32) * 5 / 9 = 20 °C
        expect(assertCharacteristic(context.services[0], CurrentTemperatureCharacteristic).value).toBeCloseTo(20);
    });

    it('binds a water-percent icon humidity sensor and pushes CurrentRelativeHumidity', () => {
        const { component, raw, state } = createFakeSensorComponent({
            unitOfMeasurement: '%',
            icon: 'mdi:water-percent',
        });
        const { accessory, context } = createFakeAccessory();

        // The helper returns the teardown (a defined function), not undefined.
        expect(sensorHelper(component, accessory, createFakeApi())).toBeTypeOf('function');
        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'humidity-service-uuid');

        raw.value = 55;
        state.next({});
        expect(assertCharacteristic(context.services[0], CurrentRelativeHumidityCharacteristic).value).toBe(55);
    });

    it('binds a humidity deviceClass sensor the same way without the icon (the other disjunct)', () => {
        const { component, raw, state } = createFakeSensorComponent({
            unitOfMeasurement: '%',
            deviceClass: 'humidity',
        });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBeTypeOf('function');
        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'humidity-service-uuid');

        raw.value = 48;
        state.next({});
        expect(assertCharacteristic(context.services[0], CurrentRelativeHumidityCharacteristic).value).toBe(48);
    });

    it('skips the °F push while no measurement is available, so NaN can never reach the characteristic', () => {
        const { component, state } = createFakeSensorComponent({ unitOfMeasurement: '°F', value: undefined });
        const { accessory, context } = createFakeAccessory();

        expect(sensorHelper(component, accessory, createFakeApi())).toBeTypeOf('function');

        // project deliberately returns undefined for a missing value: the (x-32) * 5 / 9 °F
        // conversion must never push NaN. The characteristic's value stays untouched.
        state.next({});
        expect(assertCharacteristic(context.services[0], CurrentTemperatureCharacteristic).value).toBeUndefined();
    });
});
