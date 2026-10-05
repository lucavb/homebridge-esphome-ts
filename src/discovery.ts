import Bonjour, { BonjourService } from 'bonjour-hap';
import { Logging } from 'homebridge';
import { isIPv4, isIPv6 } from 'node:net';
import { Observable } from 'rxjs';
import { map } from 'rxjs';

const DEFAULT_PORT = 6053;

interface DiscoveryResult {
    host: string;
    port?: number;
    address?: string;
}

export const discoverDevices = (timeout: number, log: Logging): Observable<DiscoveryResult> => {
    const bonjour = new Bonjour();
    return new Observable<BonjourService>((subscriber) => {
        const browser = bonjour.find({ type: 'esphomelib' }, (service) => {
            subscriber.next(service);
        });
        setTimeout(() => {
            browser.stop();
            subscriber.complete();
        }, timeout);
    }).pipe(
        map((findResult: BonjourService) => {
            log.info('HAP Device discovered', findResult.name);
            const address = findResult.addresses.find((addr) => {
                return (isIPv4(addr) && addr.substring(0, 7) !== '169.254') || isIPv6(addr);
            });
            const port = findResult.port && findResult.port !== DEFAULT_PORT ? findResult.port : undefined;
            return {
                host: findResult.host,
                port,
                address,
            };
        }),
    );
};
