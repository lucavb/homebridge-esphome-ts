import { PlatformAccessory, Service as HAPService } from 'homebridge';
import { SensorComponent } from 'esphome-ts';
import { Subscription } from 'rxjs';
import { tap } from 'rxjs/operators';

import { Characteristic, Service } from '../hap';

const fahrenheitUnit = '°F';

const isTemperatureComponent = (unitOfMeasurement: unknown) =>
    unitOfMeasurement === '°C' || unitOfMeasurement === fahrenheitUnit;

const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;

export const sensorHelper = (component: SensorComponent, accessory: PlatformAccessory): Subscription | false => {
    if (isTemperatureComponent(component.unitOfMeasurement)) {
        return defaultSetup(component, accessory, Service.TemperatureSensor, Characteristic.CurrentTemperature);
    }
    if (
        component.unitOfMeasurement === '%' &&
        (component.icon === 'mdi:water-percent' || component.deviceClass === 'humidity')
    ) {
        return defaultSetup(component, accessory, Service.HumiditySensor, Characteristic.CurrentRelativeHumidity);
    }
    return false;
};

const defaultSetup = (
    component: SensorComponent,
    accessory: PlatformAccessory,
    SelectedService: typeof Service.TemperatureSensor | typeof Service.HumiditySensor,
    SelectedCharacteristic: typeof Characteristic.CurrentTemperature | typeof Characteristic.CurrentRelativeHumidity,
): Subscription => {
    let temperatureSensor: HAPService | undefined = accessory.services.find(
        (service) => service.UUID === SelectedService.UUID,
    );
    if (!temperatureSensor) {
        temperatureSensor = accessory.addService(new SelectedService(component.name, ''));
    }
    const valuesAreFahrenheit = component.unitOfMeasurement === fahrenheitUnit;

    return component.state$
        .pipe(
            tap(() => {
                const celsiusValue =
                    valuesAreFahrenheit && component.value !== undefined
                        ? fahrenheitToCelsius(component.value)
                        : component.value;
                temperatureSensor?.getCharacteristic(SelectedCharacteristic)?.updateValue(celsiusValue!);
            }),
        )
        .subscribe();
};
