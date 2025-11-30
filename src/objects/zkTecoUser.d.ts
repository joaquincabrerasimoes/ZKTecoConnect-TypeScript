import { ZKTecoClient } from "./zkTecoClient.js";
import type { ZKTecoAttendance, ZKTecoFinger } from "../others/interfaces.js";
declare class ZKTecoUser {
    uid: number;
    role: number;
    password: string;
    name: string;
    card: number;
    userId: string;
    client: ZKTecoClient;
    constructor(uid: number, role: number, password: string, name: string, card: number, userId: string, client: ZKTecoClient);
    getAttendance(): Promise<ZKTecoAttendance[]>;
    getTemplates(): Promise<ZKTecoFinger[]>;
    toString(): string;
}
export { ZKTecoUser };
//# sourceMappingURL=zkTecoUser.d.ts.map