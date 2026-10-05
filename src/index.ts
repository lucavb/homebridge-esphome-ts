import { API } from 'homebridge';
import { EsphomePlatform } from './platform.js';
import { PLUGIN_NAME, PLATFORM_NAME } from './constants.js';

export default (api: API) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EsphomePlatform);
};
