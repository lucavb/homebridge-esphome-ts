import { tap } from 'rxjs';
import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import type { SensorComponent } from 'esphome-ts';

const fahrenheitUnit = '°F';

const isTemperatureComponent = (unitOfMeasurement: unknown) =>
    unitOfMeasurement === '°C' || unitOfMeasurement === fahrenheitUnit;

const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;

/** Valid range of the HomeKit CurrentAmbientLightLevel characteristic. */
const MIN_AMBIENT_LIGHT_LUX = 0.0001;
const MAX_AMBIENT_LIGHT_LUX = 100_000;

interface ValueClamp {
    min: number;
    max: number;
}

const clampTo = (value: number, clamp: ValueClamp): number => Math.max(clamp.min, Math.min(clamp.max, value));

export const sensorHelper = (component: SensorComponent, accessory: PlatformAccessory, api: API): boolean => {
    const { Characteristic: CharacteristicClass, Service: ServiceClass } = api.hap;
    if (isTemperatureComponent(component.unitOfMeasurement)) {
        defaultSetup(component, accessory, ServiceClass.TemperatureSensor, CharacteristicClass.CurrentTemperature);
        return true;
    } else if (
        component.unitOfMeasurement === '%' &&
        (component.icon === 'mdi:water-percent' || component.deviceClass === 'humidity')
    ) {
        defaultSetup(component, accessory, ServiceClass.HumiditySensor, CharacteristicClass.CurrentRelativeHumidity);
        return true;
    } else if (component.unitOfMeasurement === 'lx' || component.deviceClass === 'illuminance') {
        defaultSetup(component, accessory, ServiceClass.LightSensor, CharacteristicClass.CurrentAmbientLightLevel, {
            min: MIN_AMBIENT_LIGHT_LUX,
            max: MAX_AMBIENT_LIGHT_LUX,
        });
        return true;
    }
    return false;
};

type SelectedServiceType =
    typeof Service.TemperatureSensor | typeof Service.HumiditySensor | typeof Service.LightSensor;
type SelectedCharacteristicType =
    | typeof Characteristic.CurrentTemperature
    | typeof Characteristic.CurrentRelativeHumidity
    | typeof Characteristic.CurrentAmbientLightLevel;

const defaultSetup = (
    component: SensorComponent,
    accessory: PlatformAccessory,
    SelectedService: SelectedServiceType,
    SelectedCharacteristic: SelectedCharacteristicType,
    clamp?: ValueClamp,
): void => {
    let sensorService: InstanceType<SelectedServiceType> | undefined = accessory.services.find(
        (service) => service.UUID === SelectedService.UUID,
    );
    if (!sensorService) {
        sensorService = accessory.addService(new SelectedService(component.name, ''));
    }
    const valuesAreFahrenheit = component.unitOfMeasurement === fahrenheitUnit;

    component.state$
        .pipe(
            tap(() => {
                const convertedValue =
                    valuesAreFahrenheit && component.value !== undefined
                        ? fahrenheitToCelsius(component.value)
                        : component.value;
                if (convertedValue === undefined) {
                    // No measurement yet; silently skip so a throw cannot kill the state$ subscription.
                    return;
                }
                const characteristicValue = clamp === undefined ? convertedValue : clampTo(convertedValue, clamp);
                sensorService?.getCharacteristic(SelectedCharacteristic)?.setValue(characteristicValue);
            }),
        )
        .subscribe();
};
