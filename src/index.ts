import { API } from 'homebridge';

import { EsphomePlatform, PLATFORM_NAME } from './platform';

export default (api: API) => {
    api.registerPlatform(PLATFORM_NAME, EsphomePlatform);
};
