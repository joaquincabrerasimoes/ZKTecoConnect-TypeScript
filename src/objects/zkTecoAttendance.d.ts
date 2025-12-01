declare enum ZKAttendanceStatus {
    empty = 0,// 0
    fingerprint = 1,// 1
    face = 2,// 2
    password = 3,// 3
    card = 4
}
declare class ZKTecoAttendance {
    userId: string;
    uid: number;
    timestamp: Date;
    status: number;
    punch: number;
    constructor(userId: string, uid: number, timestamp: Date, status: number, punch: number);
    get identificationMethod(): ZKAttendanceStatus;
    get identificationMethodString(): string;
    get identificationMethodIcon(): string;
    toString(): string;
    toJson(): Record<string, any>;
}
export { ZKTecoAttendance };
//# sourceMappingURL=zkTecoAttendance.d.ts.map