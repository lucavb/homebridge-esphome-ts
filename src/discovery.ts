import Bonjour, { BonjourService } from 'bonjour-hap';
import { Logging } from 'homebridge';
import ip from 'ip';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const bonjour = new Bonjour();

const DEFAULT_PORT = 6053;

interface DiscoveryResult {
    host: string;
    port?: number;
    address?: string;
}

export const discoverDevices = (timeout: number, log: Logging): Observable<DiscoveryResult> => {
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
                return (ip.isV4Format(addr) && addr.substring(0, 7) !== '169.254') || ip.isV6Format(addr);
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
