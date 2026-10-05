import { tap } from 'rxjs';
import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import type { SensorComponent } from 'esphome-ts';

const fahrenheitUnit = '°F';

const isTemperatureComponent = (unitOfMeasurement: unknown) =>
    unitOfMeasurement === '°C' || unitOfMeasurement === fahrenheitUnit;

const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;

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
    }
    return false;
};

const defaultSetup = (
    component: SensorComponent,
    accessory: PlatformAccessory,
    SelectedService: typeof Service.TemperatureSensor | typeof Service.HumiditySensor,
    SelectedCharacteristic: typeof Characteristic.CurrentTemperature | typeof Characteristic.CurrentRelativeHumidity,
): void => {
    let temperatureSensor: InstanceType<typeof SelectedService> | undefined = accessory.services.find(
        (service) => service.UUID === SelectedService.UUID,
    );
    if (!temperatureSensor) {
        temperatureSensor = accessory.addService(new SelectedService(component.name, ''));
    }
    const valuesAreFahrenheit = component.unitOfMeasurement === fahrenheitUnit;

    component.state$
        .pipe(
            tap(() => {
                const celsiusValue =
                    valuesAreFahrenheit && component.value !== undefined
                        ? fahrenheitToCelsius(component.value)
                        : component.value;
                if (celsiusValue === undefined) {
                    // No measurement yet; silently skip so a throw cannot kill the state$ subscription.
                    return;
                }
                temperatureSensor?.getCharacteristic(SelectedCharacteristic)?.setValue(celsiusValue);
            }),
        )
        .subscribe();
};
