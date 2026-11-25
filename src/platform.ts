import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type { Observable } from 'rxjs';
import { concat, defer, from, Subscription } from 'rxjs';
import { filter, map } from 'rxjs';
import { EspDevice } from 'esphome-ts';

import { createAccessoryRegistry } from './accessoryRegistry.js';
import type { AccessoryRegistry } from './accessoryRegistry.js';
import { writeReadDataToLogFile } from './shared/index.js';
import { startDeviceSession } from './deviceSession.js';
import type { DebugDumpWriter } from './deviceSession.js';
import { discoverDevices } from './discovery.js';
import { createDiscoveryConfigMerge, readDeviceEntries, resolveDeviceConfig } from './deviceConfig.js';
import type { DeviceConfigDefaults, ResolvedDeviceConfig } from './deviceConfig.js';

interface IEsphomeDeviceConfig {
    host: string;
    port?: number;
    password?: string;
    /** Base64-encoded 32-byte Noise PSK from ESPHome's `api: encryption: key:`. */
    encryptionKey?: string;
    /** Swap HomeKit clockwise/counter-clockwise for fans whose forward/reverse wiring is inverted. */
    invertFanDirection?: boolean;
    retryAfter?: number;
}

interface IEsphomePlatformConfig extends PlatformConfig {
    devices?: IEsphomeDeviceConfig[];
    blacklist?: string[];
    debug?: boolean;
    retryAfter?: number;
    discover?: boolean;
    discoveryTimeout?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT = 5_000; // milliseconds

const isResolvedDeviceConfig = (config: ResolvedDeviceConfig | undefined): config is ResolvedDeviceConfig =>
    config !== undefined;

/** The debug dump reaches into the library's socket; only a real EspDevice can be tapped. */
const writeEspDeviceDebugDump: DebugDumpWriter = (host, device, onWriteError) =>
    device instanceof EspDevice ? writeReadDataToLogFile(host, device, onWriteError) : undefined;

/**
 * The platform owns the Device intake (configured entries plus Discovery) and one Device
 * session per resolved Device. The Accessory registry owns everything HomeKit-side; the
 * platform never touches an Accessory itself.
 */
export class EsphomePlatform implements DynamicPlatformPlugin {
    protected readonly subscription: Subscription;
    protected readonly registry: AccessoryRegistry;

    constructor(
        protected readonly log: Logging,
        protected readonly config: IEsphomePlatformConfig,
        protected readonly api: API,
        /** Test seam: specs inject a fake session without mocking the module. */
        protected readonly startSession: typeof startDeviceSession = startDeviceSession,
        /** Test seam: specs inject a fake registry and assert what the platform hands it. */
        createRegistry: typeof createAccessoryRegistry = createAccessoryRegistry,
    ) {
        this.subscription = new Subscription();
        this.log('starting esphome');
        if (!Array.isArray(this.config.devices) && !this.config.discover) {
            this.log.error(
                'You did not specify a devices array and discovery is ' +
                    'disabled! Esphome will not provide any accessories',
            );
            this.config.devices = [];
        }
        const rawBlacklist: unknown = this.config.blacklist;
        if (rawBlacklist !== undefined && !Array.isArray(rawBlacklist)) {
            this.log.warn('The "blacklist" configuration must be an array; ignoring it.');
        }
        const blacklist = new Set<string>(
            Array.isArray(rawBlacklist) ? rawBlacklist.filter((name): name is string => typeof name === 'string') : [],
        );

        this.registry = createRegistry({
            api: this.api,
            log: this.log,
            blacklist,
            debug: this.config.debug === true,
        });
        // The registry's teardowns join the same aggregate as the session stops: on shutdown
        // every binding subscription and every lifecycle stream is unsubscribed.
        this.subscription.add(() => this.registry.stop());

        this.api.on('didFinishLaunching', () => {
            this.onHomebridgeDidFinishLaunching();
        });
        this.api.on('shutdown', () => {
            // Each session's stop is a teardown on this aggregate: it terminates the Device,
            // unsubscribes its lifecycle streams, and completes components$/alive$.
            this.subscription.unsubscribe();
        });
    }

    protected onHomebridgeDidFinishLaunching(): void {
        const rawDevices = readDeviceEntries(this.config.devices, this.log);
        const defaults: DeviceConfigDefaults = { globalRetryAfter: this.config.retryAfter };
        let devices: Observable<ResolvedDeviceConfig>;
        if (this.config.discover) {
            const merge = createDiscoveryConfigMerge(rawDevices, defaults, this.log);
            devices = concat(
                discoverDevices(this.config.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT, this.log).pipe(
                    map((discovered) => merge.merge(discovered)),
                    filter(isResolvedDeviceConfig),
                ),
                // Feed into output remaining devices from config that haven't been discovered.
                // defer keeps the not-yet-merged set read at the close of the discovery window.
                defer(() => from(merge.remaining())),
            );
        } else {
            devices = from(rawDevices).pipe(
                map((raw) => resolveDeviceConfig(raw, defaults, this.log)),
                filter(isResolvedDeviceConfig),
            );
        }

        this.subscription.add(
            devices.subscribe((deviceConfig) => {
                const session = this.startSession(deviceConfig, {
                    log: this.log,
                    writeDebugDump: this.config.debug ? writeEspDeviceDebugDump : undefined,
                });
                this.subscription.add(session.stop);
                this.registry.bind(deviceConfig, session);
            }),
        );
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        this.registry.restore(accessory);
    }
}
