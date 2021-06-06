import Bonjour, { BonjourFindOptions, BonjourService } from 'bonjour-hap';
import ip from 'ip';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const debug = require('debug')('homebridgeEsphomeTs');
const bonjour = new Bonjour();

const DEFAULT_PORT = 6053;

type DiscoveryResult = {
    host: string;
    port?: number;
    address?: string;
};

export function discoverDevices(timeout: number): Observable<DiscoveryResult> {
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
            debug('HAP Device discovered', findResult.name);
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
}
