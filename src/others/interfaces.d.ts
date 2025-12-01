export interface ZKTecoDeviceInfo {
    firmwareVersion: string;
    serialNumber: string;
    platform: string;
    deviceName: string;
    macAddress: string;
    deviceTime: Date;
    faceVersion: number;
    fpVersion: number;
}
export interface ZKTecoFinger {
    uid: number;
    finger: number;
    valid: number;
    template: string;
}
export interface FlushOptions {
    timeoutMs?: number;
    maxPackets?: number;
    verbose?: boolean;
}
//# sourceMappingURL=interfaces.d.ts.map