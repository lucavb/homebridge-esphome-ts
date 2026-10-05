import { tap } from 'rxjs';
import type { API, CharacteristicValue, PlatformAccessory, Service as HAPService } from 'homebridge';
import { HAPStatus } from 'homebridge';
import type { LightComponent, LightStateEvent } from 'esphome-ts';

// DEFAULT_NO_EFFECT from esphome-ts v3 was removed in v4; its v3 value was the string 'None'.
const NO_EFFECT = 'None';

export const lightHelper = (component: LightComponent, accessory: PlatformAccessory, api: API): boolean => {
    const { Characteristic: CharacteristicClass, Service } = api.hap;
    let lightBulbService: HAPService | undefined = accessory.services.find(
        (service: HAPService) => service.UUID === Service.Lightbulb.UUID,
    );
    if (!lightBulbService) {
        lightBulbService = accessory.addService(new Service.Lightbulb(component.name, ''));
    }
    const bulbService = lightBulbService;

    if (component.supportsRgb) {
        let lastHue: number | undefined;
        let lastSat: number | undefined;
        lightBulbService.getCharacteristic(CharacteristicClass.Hue)?.onSet(async (hue: CharacteristicValue) => {
            try {
                lastHue = hue as number;
                const hsv = component.hsv;
                hsv.hue = lastHue ?? 0;
                hsv.saturation = lastSat ?? 0;
                component.hsv = hsv;
            } catch {
                throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        });
        lightBulbService
            .getCharacteristic(CharacteristicClass.Saturation)
            ?.onSet(async (saturation: CharacteristicValue) => {
                try {
                    lastSat = saturation as number;
                } catch {
                    throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });
        lightBulbService
            .getCharacteristic(CharacteristicClass.Brightness)
            ?.onSet(async (brightness: CharacteristicValue) => {
                try {
                    const hsv = component.hsv;
                    hsv.value = brightness as number;
                    component.hsv = hsv;
                } catch {
                    throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });
    } else if (component.supportsBrightness) {
        lightBulbService
            .getCharacteristic(CharacteristicClass.Brightness)
            ?.onSet(async (brightness: CharacteristicValue) => {
                try {
                    if (typeof brightness === 'number') {
                        component.setBrightness(brightness);
                    }
                } catch {
                    throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });
    }

    lightBulbService.getCharacteristic(CharacteristicClass.On)?.onSet(async (on: CharacteristicValue) => {
        try {
            if (on) {
                component.turnOn();
            } else {
                component.turnOff();
            }
        } catch {
            throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    });

    const effects = component
        .availableEffects()
        .filter((effect: string) => effect !== NO_EFFECT)
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
            service?.getCharacteristic(CharacteristicClass.On)?.onSet(async (on: CharacteristicValue) => {
                try {
                    component.effect = on ? name : NO_EFFECT;
                    effects
                        .filter(({ name: otherEffectName }) => otherEffectName !== name)
                        .forEach(({ service: otherEffectService }) => {
                            otherEffectService?.getCharacteristic(CharacteristicClass.On).updateValue(false);
                        });
                } catch {
                    throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
            });
        });
    }

    component.state$
        .pipe(
            tap((state: LightStateEvent) => {
                bulbService.getCharacteristic(CharacteristicClass.On)?.updateValue(!!state.state);
                if (component.supportsRgb) {
                    const hsv = component.hsv;
                    bulbService.getCharacteristic(CharacteristicClass.Hue)?.updateValue(hsv.hue);
                    bulbService.getCharacteristic(CharacteristicClass.Saturation)?.updateValue(hsv.saturation);
                    bulbService.getCharacteristic(CharacteristicClass.Brightness)?.updateValue(hsv.value);
                } else if (component.supportsBrightness) {
                    bulbService
                        .getCharacteristic(CharacteristicClass.Brightness)
                        ?.updateValue((state.brightness ?? 0) * 100);
                }
                if (effects.length > 0) {
                    effects.forEach(({ name: effectName, service: effectService }): void => {
                        effectService
                            ?.getCharacteristic(CharacteristicClass.On)
                            ?.updateValue(effectName === state.effect);
                    });
                }
            }),
        )
        .subscribe();

    return true;
};
