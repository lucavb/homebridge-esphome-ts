import { tap } from 'rxjs/operators';
import {
    CharacteristicEventTypes,
    CharacteristicSetCallback,
    CharacteristicValue,
    PlatformAccessory,
    Service as HAPService,
} from 'homebridge';
import { Characteristic, Service } from '../index';
import { ComponentHelper } from './componentHelpers';
import { DEFAULT_NO_EFFECT, LightComponent, LightStateEvent } from 'esphome-ts';

export const lightHelper: ComponentHelper = (component: LightComponent, accessory: PlatformAccessory): boolean => {
    let lightBulbService: HAPService | undefined = accessory.services.find(
        (service: HAPService) => service.UUID === Service.Lightbulb.UUID,
    );
    if (!lightBulbService) {
        lightBulbService = accessory.addService(new Service.Lightbulb(component.name, ''));
    }

    if (component.supportsRgb) {
        let lastHue: number | undefined;
        let lastSat: number | undefined;
        lightBulbService
            .getCharacteristic(Characteristic.Hue)
            ?.on(CharacteristicEventTypes.SET, (hue: CharacteristicValue, callback: CharacteristicSetCallback) => {
                lastHue = hue as number;
                const hsv = component.hsv;
                hsv.hue = lastHue ?? 0;
                hsv.saturation = lastSat ?? 0;
                component.hsv = hsv;
                callback();
            });
        lightBulbService
            .getCharacteristic(Characteristic.Saturation)
            ?.on(
                CharacteristicEventTypes.SET,
                (saturation: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    lastSat = saturation as number;
                    callback();
                },
            );
        lightBulbService
            .getCharacteristic(Characteristic.Brightness)
            ?.on(
                CharacteristicEventTypes.SET,
                (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    const hsv = component.hsv;
                    hsv.value = brightness as number;
                    component.hsv = hsv;
                    callback();
                },
            );
    } else if (component.supportsBrightness) {
        lightBulbService
            .getCharacteristic(Characteristic.Brightness)
            ?.on(
                CharacteristicEventTypes.SET,
                (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    if (typeof brightness === 'number') {
                        component.setBrightness(brightness);
                    }
                    callback();
                },
            );
    }

    lightBulbService
        .getCharacteristic(Characteristic.On)
        ?.on(CharacteristicEventTypes.SET, (on: CharacteristicValue, callback: CharacteristicSetCallback) => {
            on ? component.turnOn() : component.turnOff();
            callback();
        });

    const effects = component
        .availableEffects()
        .filter((effect: string) => effect !== DEFAULT_NO_EFFECT)
        .map((effect: string) => {
            const switchName = `${component.name} - ${effect}`;
            const switchSubType = `${effect} Switch`;
            let switchService: HAPService | undefined = accessory.services.find(
                (service: HAPService) => service.UUID === Service.Switch.UUID && service.subtype === switchSubType,
            );
            if (!switchService) {
                switchService = accessory.addService(new Service.Switch(switchName, switchSubType));
            }
            return {
                service: switchService,
                name: effect,
            };
        });

    if (effects.length > 0) {
        effects.forEach(({ name, service }): void => {
            service
                ?.getCharacteristic(Characteristic.On)
                ?.on(CharacteristicEventTypes.SET, (on: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    component.effect = on ? name : DEFAULT_NO_EFFECT;
                    effects
                        .filter(({ name: otherEffectName }) => otherEffectName !== name)
                        .forEach(({ service: otherEffectService }) => {
                            otherEffectService?.getCharacteristic(Characteristic.On).updateValue(false);
                        });
                    callback();
                });
        });
    }

    component.state$
        .pipe(
            tap((state: LightStateEvent) => {
                lightBulbService!.getCharacteristic(Characteristic.On)?.updateValue(!!state.state);
                if (component.supportsRgb) {
                    const hsv = component.hsv;
                    lightBulbService!.getCharacteristic(Characteristic.Hue)?.updateValue(hsv.hue);
                    lightBulbService!.getCharacteristic(Characteristic.Saturation)?.updateValue(hsv.saturation);
                    lightBulbService!.getCharacteristic(Characteristic.Brightness)?.updateValue(hsv.value);
                } else if (component.supportsBrightness) {
                    lightBulbService!
                        .getCharacteristic(Characteristic.Brightness)
                        ?.updateValue((state.brightness ?? 0) * 100);
                }
                if (effects.length > 0) {
                    effects.forEach(({ name: effectName, service: effectService }): void => {
                        effectService?.getCharacteristic(Characteristic.On)?.updateValue(effectName === state.effect);
                    });
                }
            }),
        )
        .subscribe();

    return true;
};
