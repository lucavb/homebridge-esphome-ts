import {HomebridgePlatformAccessory} from 'homebridge-ts-helper';
import {ComponentType} from 'esphome-ts/dist/components/entities';
import {lightHelper} from './light';
import {binarySensorHelper} from './binarySensor';
import {sensorHelper} from './sensor';
import {switchHelper} from './switch';

export type ComponentHelper = (component: any, accessory: HomebridgePlatformAccessory) => boolean;

export const componentHelpers = new Map<ComponentType, ComponentHelper>([
    ['light', lightHelper],
    ['binarySensor', binarySensorHelper],
    ['sensor', sensorHelper],
    ['switch', switchHelper],
]);
