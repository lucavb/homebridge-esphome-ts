import { lightHelper } from './light';
import { binarySensorHelper } from './binarySensor';
import { sensorHelper } from './sensor';
import { switchHelper } from './switch';
import { climateHelper } from './climate';
import { coverHelper } from './cover';
import { PlatformAccessory } from 'homebridge';

export type ComponentHelper = (component: any, accessory: PlatformAccessory) => boolean;

export const componentHelpers = new Map<string, ComponentHelper>([
    ['Light', lightHelper],
    ['BinarySensor', binarySensorHelper],
    ['Sensor', sensorHelper],
    ['Switch', switchHelper],
    ['Climate', climateHelper],
    ['Cover', coverHelper],
]);
