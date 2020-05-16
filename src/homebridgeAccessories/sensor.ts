import {HomebridgePlatformAccessory} from 'homebridge-ts-helper';
import {SensorComponent} from 'esphome-ts/dist';
import {Characteristic, Service} from 'hap-nodejs';
import {
    CurrentRelativeHumidity,
    CurrentTemperature,
    HumiditySensor,
    TemperatureSensor,
} from 'hap-nodejs/dist/lib/gen/HomeKit';
import {tap} from 'rxjs/operators';

const isTemperatureComponent = (unitOfMeasurement: unknown) => unitOfMeasurement === '°C' || unitOfMeasurement === '°F';

export const sensorHelper = (component: SensorComponent, accessory: HomebridgePlatformAccessory): boolean => {
    if (isTemperatureComponent(component.unitOfMeasurement)) {
        defaultSetup(component, accessory, TemperatureSensor, Characteristic.CurrentTemperature);
        return true;
    } else if (component.unitOfMeasurement === '%' && component.icon === 'mdi:water-percent') {
        defaultSetup(component, accessory, HumiditySensor, CurrentRelativeHumidity);
        return true;
    }
    return false;
};

const defaultSetup = (component: SensorComponent,
                      accessory: HomebridgePlatformAccessory,
                      SelectedService: typeof TemperatureSensor | typeof HumiditySensor,
                      SelectedCharacteristic: typeof CurrentTemperature | typeof CurrentRelativeHumidity): void => {
    let temperatureSensor: Service | undefined = accessory.services.find((service) => service.UUID === SelectedService.UUID);
    if (!temperatureSensor) {
        temperatureSensor = accessory.addService(new SelectedService(component.name, ''));
    }

    component.state$.pipe(
        tap(() => temperatureSensor?.getCharacteristic(SelectedCharacteristic)?.setValue(component.value!)),
    ).subscribe();
};
