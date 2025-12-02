import { ZKAttendanceIDMethod } from '../others/enums';
declare class ZKTecoAttendance {
    uid: number;
    userId: string;
    timestamp: Date;
    idMethod: number;
    punch: number;
    constructor(userId: string, uid: number, timestamp: Date, idMethod: number, punch: number);
    get identificationMethod(): ZKAttendanceIDMethod;
    get identificationMethodString(): string;
    get identificationMethodIcon(): string;
    toString(): string;
    toJson(): Record<string, any>;
}
export { ZKTecoAttendance };
//# sourceMappingURL=zkTecoAttendance.d.ts.map