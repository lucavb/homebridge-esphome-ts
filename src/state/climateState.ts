export enum ClimateMode {
    OFF = 0,
    AUTO = 1, // => Characteristic.TargetHeaterCoolerState.AUTO
    COOL = 2, // => Characteristic.TargetHeaterCoolerState.COOL
    HEAT = 3, // => Characteristic.TargetHeaterCoolerState.HEAT
    FAN_ONLY = 4,
    DRY = 5,
}

enum ClimateFanState {
    ON = 0,
    OFF = 1,
    AUTO = 2,
    LOW = 3,
    MEDIUM = 4,
    HIGH = 5,
    MIDDLE = 6,
    FOCUS = 7,
    DIFFUSED = 8,
    QUIET = 9,
}



export class ClimateState {

    private date: Date = new Date();
    private temperatureLastChanged: number = this.date.getTime();

    private Active: boolean = false;
    private FanMode: ClimateFanState = ClimateFanState.OFF;
    private ClimateMode: ClimateMode = ClimateMode.OFF;
    private SwingMode: number = 0; // RotationDirection

    private key: string = '';

    private TargetTemperature: number = 0;
    private CurrentTemperature: number = 0;
    private TargetTemperatureLow: number = 0;
    private TargetTemperatureHigh: number = 0;

    private connection: any;
    private changesMade: boolean = false;

    // private previousClimateState : ClimateState = null;

    // implement ClimateState constructor
    public constructor(connection: any, key: string) {
        this.connection = connection;
        this.key = key;
    }

    public UpdateEsp(){
        if(!this.changesMade) {
            return;
        }

        this.connection.climateCommandService({
            key: this.key,
            swingMode: this.SwingMode,
            fanMode: this.FanMode,
            mode: this.ClimateMode, // Heater/Cooler ClimateMode
            targetTemperature: this.TargetTemperature,
            targetTemperatureLow: this.ClimateMode === ClimateMode.AUTO ? this.targetTemperatureLow : this.TargetTemperature,
            targetTemperatureHigh: this.ClimateMode === ClimateMode.AUTO ? this.targetTemperatureHigh : this.TargetTemperature,
        });

    }

    public get active(): boolean {
        return this.Active;
    }
    public set active(value: boolean) {
        let mode = value ? this.ClimateMode : ClimateMode.OFF;
        if(value && mode === ClimateMode.OFF) {
            mode = ClimateMode.AUTO;
        }

        this.ClimateMode = mode;
        if(this.Active !== value){
            this.changesMade = true;
        }
        this.Active = value;
    }

    public get fanMode(): ClimateFanState {
        return this.FanMode;
    }
    public set fanMode(value: ClimateFanState) {
        // this.previousClimateState = Object.assign({}, this);

        if(this.FanMode !== value){
            this.changesMade = true;
        }
        this.FanMode = value;
    }
    public get climateMode(): ClimateMode {
        return this.ClimateMode;
    }
    public set climateMode(value: ClimateMode) {
        if(this.ClimateMode !== value){
            this.changesMade = true;
        }
        this.ClimateMode = value;
    }

    public get swingMode(): number {
        return this.SwingMode;
    }
    public set swingMode(value: number) {
        if(this.SwingMode !== value){
            this.changesMade = true;
        }
        this.SwingMode = value;
    }

    public get targetTemperature(): number {
        return this.TargetTemperature;
    }
    public set targetTemperature(value: number) {
        if(this.targetTemperature !== value){
            this.changesMade = true;
        }

        this.temperatureLastChanged = this.date.getTime();
        this.TargetTemperature = value;
    }
    public get currentTemperature(): number {
        return this.CurrentTemperature;
    }
    public set currentTemperature(value: number) {
        this.CurrentTemperature = value;
    }
    public get targetTemperatureLow(): number {
        return this.TargetTemperatureLow;
    }
    public set targetTemperatureLow(value: number) {
        if(this.targetTemperatureLow !== value){
            this.changesMade = true;
        }

        this.ClimateMode = this.getClimateMode(ClimateMode.COOL);
        this.TargetTemperatureLow = value;
    }
    public get targetTemperatureHigh(): number {
        return this.TargetTemperatureHigh;
    }
    
    public set targetTemperatureHigh(value: number) {
        if(this.targetTemperatureHigh !== value){
            this.changesMade = true;
        }

        this.ClimateMode = this.getClimateMode(ClimateMode.HEAT);
        this.TargetTemperatureHigh = value;
    }

    
    private getClimateMode(mode: ClimateMode) : ClimateMode {
        let state: any;
        // 2 events will be received, so we need to capture both to set the mode to AUTO
        if ( Math.abs(this.date.getTime() - this.temperatureLastChanged) < 50) {
            return ClimateMode.AUTO;
        } else {
            return mode;
        }
    }
}