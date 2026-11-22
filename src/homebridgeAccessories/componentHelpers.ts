import { lightHelper } from './light.js';
import { binarySensorHelper } from './binarySensor.js';
import { coverHelper } from './cover.js';
import { sensorHelper } from './sensor.js';
import { switchHelper } from './switch.js';
import type { API, PlatformAccessory } from 'homebridge';
import type { BaseComponent, ComponentType } from 'esphome-ts';

export type ComponentHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
) => (() => void) | undefined;

export const componentHelpers = new Map<ComponentType, ComponentHelper>([
    ['light', lightHelper],
    ['binarySensor', binarySensorHelper],
    ['cover', coverHelper],
    ['sensor', sensorHelper],
    ['switch', switchHelper],
]);
