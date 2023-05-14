import { lightHelper } from './light';
import { binarySensorHelper } from './binarySensor';
import { coverHelper } from './cover';
import { sensorHelper } from './sensor';
import { switchHelper } from './switch';
import { PlatformAccessory } from 'homebridge';
import { ComponentType } from 'esphome-ts';

export type ComponentHelper = (component: any, accessory: PlatformAccessory) => boolean;

export const componentHelpers = new Map<ComponentType, ComponentHelper>([
    ['light', lightHelper],
    ['binarySensor', binarySensorHelper],
    ['sensor', sensorHelper],
    ['switch', switchHelper],
    ['cover', coverHelper]
]);
