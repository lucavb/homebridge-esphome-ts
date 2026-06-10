import { PlatformConfig } from 'homebridge';

export const DEFAULT_RETRY_AFTER = 90_000;
export const DEFAULT_DISCOVERY_TIMEOUT = 5_000;

export interface DeviceOptions {
    host: string;
    port?: number;
    password?: string;
    retryAfter?: number;
}

/**
 * Handles configuration options for the platform.
 */
export class PlatformOptions {
    readonly devices: DeviceOptions[];
    readonly blacklist: string[];
    readonly debug: boolean;
    readonly discover: boolean;
    readonly discoveryTimeout: number;
    readonly retryAfter: number;

    constructor(config: PlatformConfig) {
        this.devices = Array.isArray(config.devices) ? (config.devices as DeviceOptions[]) : [];
        this.blacklist = Array.isArray(config.blacklist) ? (config.blacklist as string[]) : [];
        this.debug = !!config.debug;
        this.discover = !!config.discover;
        this.discoveryTimeout =
            typeof config.discoveryTimeout === 'number' ? config.discoveryTimeout : DEFAULT_DISCOVERY_TIMEOUT;
        this.retryAfter = typeof config.retryAfter === 'number' ? config.retryAfter : DEFAULT_RETRY_AFTER;
    }
}
