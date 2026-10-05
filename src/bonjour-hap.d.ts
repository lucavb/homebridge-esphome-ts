/**
 * Type shim for `bonjour-hap` under `moduleResolution: nodenext` (TS 6).
 *
 * bonjour-hap 3.10.5 ships its own declaration file, but it is authored in
 * CommonJS format, where `export default Bonjour` is not interpreted as a
 * constructable value by TypeScript's nodenext resolution (the default import
 * resolves to the module namespace instead of the `Bonjour` factory). The
 * runtime default import behaves correctly (module.exports is the factory
 * function), so this ambient declaration restores the correct types for the
 * subset of the API this plugin uses.
 *
 * If bonjour-hap updates its declaration format, delete this file.
 */
declare module 'bonjour-hap' {
    import type { RemoteInfo } from 'node:dgram';

    /** Options accepted by the underlying multicast-dns responder. */
    export interface MulticastOptions {
        port?: number;
        type?: 'udp4' | 'udp6';
        ip?: string;
        interface?: string;
        reuseAddr?: boolean;
    }

    export interface BonjourFindOptions {
        type?: string;
        protocol?: 'tcp' | 'udp';
        name?: string;
    }

    /** A service discovered via find()/findOne(). */
    export interface BonjourService {
        name: string;
        fqdn: string;
        type: string;
        subtypes: string[];
        protocol: 'tcp' | 'udp';
        host: string;
        port: number;
        referer: RemoteInfo;
        addresses: string[];
        txt?: Record<string, string>;
    }

    export interface Browser {
        start(): void;
        stop(): void;
        update(): void;
    }

    export default class Bonjour {
        constructor(options?: MulticastOptions);
        find(options: BonjourFindOptions, onUp?: (service: BonjourService) => void): Browser;
        findOne(options: BonjourFindOptions, callback?: (service: BonjourService) => void): Browser;
        publish(options: unknown): unknown;
        unpublishAll(callback?: () => void): void;
        destroy(callback?: () => void): void;
    }
}
