import { Characteristic, Service } from '../index';
import { PlatformAccessory, Service as HAPService } from 'homebridge';

export const textSensorHelper = (component: any, accessory: PlatformAccessory): boolean => {
    
    // not sure Diagnostics makes the most sense here, but it's the closest I can find ATM 
    let sensor = accessory.addService(new  Service.Diagnostics(component.name, ''));
    
    component.on('state', (state: any) => {
        sensor.getCharacteristic(Characteristic.SupportedDiagnosticsSnapshot).setValue(state.state);
    });
    return true;
};
