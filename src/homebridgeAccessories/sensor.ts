import { tap } from 'rxjs/operators';
import { Characteristic, Service } from '../index';
import { SensorComponent } from 'esphome-ts';
import { PlatformAccessory, Service as HAPService } from 'homebridge';

const isTemperatureComponent = (unitOfMeasurement: unknown) => unitOfMeasurement === '°C' || unitOfMeasurement === '°F';

export const sensorHelper = (component: SensorComponent, accessory: PlatformAccessory): boolean => {
    if (isTemperatureComponent(component.unitOfMeasurement)) {
        defaultSetup(component, accessory, Service.TemperatureSensor, Characteristic.CurrentTemperature);
        return true;
    } else if (component.unitOfMeasurement === '%' && component.icon === 'mdi:water-percent') {
        defaultSetup(component, accessory, Service.HumiditySensor, Characteristic.CurrentRelativeHumidity);
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
    let temperatureSensor: HAPService | undefined = accessory.services.find(
        (service) => service.UUID === SelectedService.UUID,
    );
    if (!temperatureSensor) {
        temperatureSensor = accessory.addService(new SelectedService(component.name, ''));
    }

    component.state$
        .pipe(tap(() => temperatureSensor?.getCharacteristic(SelectedCharacteristic)?.setValue(component.value!)))
        .subscribe();
};
