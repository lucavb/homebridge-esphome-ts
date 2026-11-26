import { climateHelper } from './climate.js';
import { lightHelper } from './light.js';
import { binarySensorHelper } from './binarySensor.js';
import { coverHelper } from './cover.js';
import { fanHelper } from './fan.js';
import { sensorHelper } from './sensor.js';
import { switchHelper } from './switch.js';
import type { API, PlatformAccessory } from 'homebridge';
import type { BaseComponent, ComponentType } from 'esphome-ts';
import type { ComponentHelperOptions } from './componentBinding.js';

export type ComponentHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
    options?: ComponentHelperOptions,
) => (() => void) | undefined;

export const componentHelpers = new Map<ComponentType, ComponentHelper>([
    ['light', lightHelper],
    ['binarySensor', binarySensorHelper],
    ['cover', coverHelper],
    ['fan', fanHelper],
    ['climate', climateHelper],
    ['sensor', sensorHelper],
    ['switch', switchHelper],
]);
