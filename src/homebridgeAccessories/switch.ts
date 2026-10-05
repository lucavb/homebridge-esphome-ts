import type { API, PlatformAccessory } from 'homebridge';
import { isSwitchComponent } from 'esphome-ts';
import type { BaseComponent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding } from './componentBinding.js';

export const switchHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
): (() => void) | undefined => {
    if (!isSwitchComponent(component)) {
        return undefined;
    }

    const bindings: ComponentBinding[] = [
        {
            service: api.hap.Service.Switch,
            name: component.name,
            characteristic: api.hap.Characteristic.On,
            read: () => component.status,
            apply: (value) => {
                if (component.status !== !!value) {
                    if (value) {
                        component.turnOn();
                    } else {
                        component.turnOff();
                    }
                }
            },
            project: () => component.status,
        },
    ];

    return bindComponent(component, accessory, api, bindings);
};
