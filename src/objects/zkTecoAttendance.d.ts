import { ZKAttendanceIDMethod } from '../others/enums.js';
declare class ZKTecoAttendance {
    userId: string;
    uid: number;
    timestamp: Date;
    status: number;
    punch: number;
    constructor(userId: string, uid: number, timestamp: Date, status: number, punch: number);
    get identificationMethod(): ZKAttendanceIDMethod;
    get identificationMethodString(): string;
    get identificationMethodIcon(): string;
    toString(): string;
    toJson(): Record<string, any>;
}
export { ZKTecoAttendance };
//# sourceMappingURL=zkTecoAttendance.d.ts.map