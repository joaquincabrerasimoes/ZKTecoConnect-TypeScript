export interface ZKTecoUser {
    uid: number;
    role: number;
    password: string;
    name: string;
    card: number;
    userId: string;
}
export interface ZKTecoAttendance {
    userId: string;
    uid: number;
    timestamp: Date;
    status: number;
    punch: number;
}
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
//# sourceMappingURL=interfaces.d.ts.map