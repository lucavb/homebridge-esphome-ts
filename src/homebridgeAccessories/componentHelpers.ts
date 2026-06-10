import { PlatformAccessory } from 'homebridge';
import { ComponentType } from 'esphome-ts';
import { Subscription } from 'rxjs';

import { binarySensorHelper } from './binarySensor';
import { lightHelper } from './light';
import { sensorHelper } from './sensor';
import { switchHelper } from './switch';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentHelper = (component: any, accessory: PlatformAccessory) => Subscription | false;

export const componentHelpers = new Map<ComponentType, ComponentHelper>([
    ['light', lightHelper],
    ['binarySensor', binarySensorHelper],
    ['sensor', sensorHelper],
    ['switch', switchHelper],
]);
