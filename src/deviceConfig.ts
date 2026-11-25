import type { Logging } from 'homebridge';
import * as z from 'zod/mini';
import type { DiscoveryResult } from './discovery.js';

/**
 * The Device config module owns the raw `devices` intake: field validation, defaulting,
 * and normalisation. It logs the same diagnostics the platform used to emit inline, and
 * returns a typed entry only when the Device can be constructed from it.
 *
 * The rejectable shape is declared with `zod/mini`; the warn-and-continue rules (blank key,
 * both credentials, non-boolean fan knob, retry clamp) stay in the normalisation pass,
 * because they are not validation failures.
 *
 * The discovery merge stays here too, because it is the same concern: a merged entry is
 * validated once, at the moment it is emitted. Keeping the merge and the validation in one
 * module preserves the streaming behaviour — discovered Devices bind as they arrive, and
 * configured Devices that discovery did not find bind when the discovery window closes.
 */

export interface ResolvedDeviceConfig {
    readonly host: string;
    readonly password?: string;
    readonly port?: number;
    readonly encryptionKey?: string;
    /** Already clamped into Node's timer range. */
    readonly retryAfter: number;
    readonly invertFanDirection: boolean;
}

export interface DeviceConfigDefaults {
    /** Raw global `retryAfter` from the platform config; clamped here. */
    readonly globalRetryAfter?: unknown;
}

/** A `devices` array entry after the object guard, before field validation. */
export type RawDeviceEntry = Record<string, unknown>;

export const DEFAULT_RETRY_AFTER = 90_000;
/** Node clamps timer delays outside this range to 1 ms, which would become a reconnect hot loop. */
const MIN_RETRY_AFTER = 1_000;
const MAX_RETRY_AFTER = 2_147_483_647;

/** A usable timer delay in [MIN_RETRY_AFTER, MAX_RETRY_AFTER], or the fallback when unset/not a number. */
const retryDelay = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.round(value), MIN_RETRY_AFTER), MAX_RETRY_AFTER)
        : fallback;

const HOST_MESSAGE = 'A "devices" entry is missing a valid "host"; skipping it.';
const passwordMessage = (host: string): string => `The "password" configured for ${host} must be a string.`;
const portMessage = (host: string): string =>
    `The "port" configured for ${host} must be an integer between 1 and 65535.`;
const encryptionKeyMessage = (host: string): string => `The "encryptionKey" configured for ${host} must be a string.`;

/**
 * Port validation lives on the field (not an object-level refinement) so a bad port is
 * reported in field order even when another field also fails the shape. The message is
 * generic here; {@link issueMessage} supplies the host-specific text.
 */
const portSchema = z.nullish(z.union([z.number(), z.string()])).check(
    z.superRefine((port, ctx) => {
        if (port === undefined || port === null) {
            return;
        }
        const numeric = typeof port === 'number' ? port : Number(port);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
            ctx.addIssue({ code: 'custom', path: [], message: 'invalid port' });
        }
    }),
);

/**
 * The rejectable shape. `invertFanDirection` and `retryAfter` are deliberately opaque:
 * a non-boolean fan knob and an unusable retry delay warn and fall back, they do not
 * reject the Device.
 */
const rawDeviceEntrySchema = z.object({
    host: z.string().check(z.refine((host: string) => host.trim() !== '', { message: 'invalid host' })),
    password: z.nullish(z.string()),
    port: portSchema,
    encryptionKey: z.nullish(z.string()),
    invertFanDirection: z.optional(z.unknown()),
    retryAfter: z.optional(z.unknown()),
});

/** Maps a schema issue back to the Homebridge-facing text, including the configured host. */
const issueMessage = (issue: z.core.$ZodIssue, raw: RawDeviceEntry): string => {
    const host = typeof raw.host === 'string' ? raw.host : '';
    switch (issue.path[0]) {
        case 'host':
            return HOST_MESSAGE;
        case 'password':
            return passwordMessage(host);
        case 'port':
            return portMessage(host);
        case 'encryptionKey':
            return encryptionKeyMessage(host);
        default:
            return issue.message;
    }
};

/**
 * Drops entries that are not objects. The per-field validation runs later, on emission,
 * so a configured Device that discovery finds is validated against the merged entry
 * exactly once.
 */
export const readDeviceEntries = (rawDevices: unknown, log: Logging): RawDeviceEntry[] => {
    if (rawDevices !== undefined && !Array.isArray(rawDevices)) {
        log.error('The "devices" configuration must be an array; ignoring it.');
    }
    const entries: unknown[] = Array.isArray(rawDevices) ? rawDevices : [];
    const configured: RawDeviceEntry[] = [];
    for (const [index, entry] of entries.entries()) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            log.error(`Skipping devices[${index}]: it is not an object.`);
            continue;
        }
        configured.push(entry as RawDeviceEntry);
    }
    return configured;
};

/**
 * Validates one raw entry. Returns `undefined` — after logging the reason — when a field
 * makes the Device unconstructible. The warn-and-continue rules are applied here, after
 * the schema has guaranteed the types.
 */
export const resolveDeviceConfig = (
    raw: RawDeviceEntry,
    defaults: DeviceConfigDefaults,
    log: Logging,
): ResolvedDeviceConfig | undefined => {
    const parsed = rawDeviceEntrySchema.safeParse(raw);
    if (!parsed.success) {
        log.error(issueMessage(parsed.error.issues[0], raw));
        return undefined;
    }

    const value = parsed.data;
    const host = value.host;
    const password = value.password ?? undefined;
    const port = value.port === undefined || value.port === null ? undefined : Number(value.port);

    const rawEncryptionKey = value.encryptionKey;
    const trimmedKey = rawEncryptionKey?.trim() ?? '';
    if (rawEncryptionKey !== undefined && rawEncryptionKey !== null && rawEncryptionKey !== '' && trimmedKey === '') {
        // A field left as spaces is a mistake; a plain empty string is the
        // normal "unencrypted" state and stays silent.
        log.warn(`The "encryptionKey" configured for ${host} is blank; treating the device as unencrypted.`);
    }
    const encryptionKey = trimmedKey === '' ? undefined : trimmedKey;

    const rawInvertFanDirection = raw.invertFanDirection;
    if (
        rawInvertFanDirection !== undefined &&
        rawInvertFanDirection !== null &&
        typeof rawInvertFanDirection !== 'boolean'
    ) {
        log.warn(`The "invertFanDirection" configured for ${host} must be a boolean; ignoring it.`);
    }
    const invertFanDirection = rawInvertFanDirection === true;

    if (encryptionKey !== undefined && password !== undefined && password !== '') {
        log.warn(`Both "password" and "encryptionKey" are configured for ${host}. ESPHome uses one or the other.`);
    }

    const globalRetryAfter = retryDelay(defaults.globalRetryAfter, DEFAULT_RETRY_AFTER);
    const rawRetryAfter = raw.retryAfter;
    const retryAfter = retryDelay(rawRetryAfter, globalRetryAfter);
    const roundedRetryAfter = typeof rawRetryAfter === 'number' ? Math.round(rawRetryAfter) : Number.NaN;
    if (rawRetryAfter !== undefined && retryAfter !== roundedRetryAfter) {
        log.warn(`The "retryAfter" configured for ${host} is invalid; using ${retryAfter} ms.`);
    }

    return {
        host,
        password,
        port,
        encryptionKey,
        retryAfter,
        invertFanDirection,
    };
};

/** Convenience for callers that consume the whole list at once (tests, non-streaming paths). */
export const resolveDeviceConfigs = (
    rawDevices: unknown,
    defaults: DeviceConfigDefaults,
    log: Logging,
): ResolvedDeviceConfig[] => {
    const resolved: ResolvedDeviceConfig[] = [];
    for (const raw of readDeviceEntries(rawDevices, log)) {
        const config = resolveDeviceConfig(raw, defaults, log);
        if (config !== undefined) {
            resolved.push(config);
        }
    }
    return resolved;
};

export interface DiscoveryConfigMerge {
    /** Merges one discovered service with its configured entry and validates the result. */
    merge(discovered: DiscoveryResult): ResolvedDeviceConfig | undefined;
    /** Configured entries discovery did not find, validated when the discovery window closes. */
    remaining(): ResolvedDeviceConfig[];
}

/**
 * Stateful merge over the discovery window. The matched-host set is an implementation
 * detail: the platform only sees `merge` per discovered service and `remaining` at the
 * close. Validation runs on the merged entry, so the log context (including the resolved
 * address) matches the Device that will actually be constructed.
 */
export const createDiscoveryConfigMerge = (
    configured: readonly RawDeviceEntry[],
    defaults: DeviceConfigDefaults,
    log: Logging,
): DiscoveryConfigMerge => {
    const matchedHosts = new Set<string>();
    return {
        merge(discovered: DiscoveryResult): ResolvedDeviceConfig | undefined {
            const configuredEntry = configured.find((entry) => entry.host === discovered.host);
            if (configuredEntry !== undefined && typeof configuredEntry.host === 'string') {
                matchedHosts.add(configuredEntry.host);
            }
            const merged = configuredEntry === undefined ? { ...discovered } : { ...discovered, ...configuredEntry };
            // Override the hostname with the IP address when available to avoid issues with
            // mDNS resolution at OS level.
            return resolveDeviceConfig({ ...merged, host: discovered.address ?? discovered.host }, defaults, log);
        },
        remaining(): ResolvedDeviceConfig[] {
            const resolved: ResolvedDeviceConfig[] = [];
            for (const entry of configured) {
                if (typeof entry.host === 'string' && matchedHosts.has(entry.host)) {
                    continue;
                }
                const config = resolveDeviceConfig(entry, defaults, log);
                if (config !== undefined) {
                    resolved.push(config);
                }
            }
            return resolved;
        },
    };
};
