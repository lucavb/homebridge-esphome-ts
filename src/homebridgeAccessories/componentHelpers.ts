import { lightHelper } from './light.js';
import { binarySensorHelper } from './binarySensor.js';
import { sensorHelper } from './sensor.js';
import { switchHelper } from './switch.js';
import type { API, PlatformAccessory } from 'homebridge';
import type { ComponentType } from 'esphome-ts';

// The helper receives whichever component its registry entry supports; the platform router passes
// any esphome component through, so the parameter type is intentionally left open.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentHelper = (component: any, accessory: PlatformAccessory, api: API) => boolean;

export const componentHelpers = new Map<ComponentType, ComponentHelper>([
    ['light', lightHelper],
    ['binarySensor', binarySensorHelper],
    ['sensor', sensorHelper],
    ['switch', switchHelper],
]);
