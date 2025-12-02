import { ZKTecoClient } from "./zkTecoClient.js";
import type { ZKTecoFinger } from "../others/interfaces.js";
import { ZKTecoAttendance } from './zkTecoAttendance';
declare class ZKTecoUser {
    uid: number;
    privilege: number;
    password: string;
    name: string;
    card: number;
    groupId: string;
    userId: string;
    client: ZKTecoClient;
    rawData: string;
    constructor(uid: number, privilege: number, password: string, name: string, card: number, groupId: string, userId: string, client: ZKTecoClient);
    getAttendance(): Promise<ZKTecoAttendance[]>;
    getTemplates(): Promise<ZKTecoFinger[]>;
    toString(): string;
    toStringWithRawData(): string;
}
export { ZKTecoUser };
//# sourceMappingURL=zkTecoUser.d.ts.map