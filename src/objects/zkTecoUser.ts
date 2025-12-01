import { ZKTecoClient } from "./zkTecoClient.js";
import type { ZKTecoAttendance, ZKTecoFinger } from "../others/interfaces.js";

class ZKTecoUser {
    uid: number;
    role: number;
    password: string;
    name: string;
    card: number;
    groupId: string;
    userId: string;
    client: ZKTecoClient;

    rawData: string = '';

    constructor(uid: number, role: number, password: string, name: string, card: number, groupId: string, userId: string, client: ZKTecoClient) {
        this.uid = uid;
        this.role = role;
        this.password = password;
        this.name = name;
        this.card = card;
        this.groupId = groupId;
        this.userId = userId;
        this.client = client;
    }

    public async getAttendance(): Promise<ZKTecoAttendance[]> {
        var toReturn: ZKTecoAttendance[] = [];

        var attendance: ZKTecoAttendance[] = await this.client.getAttendance();

        if (attendance != undefined) {
            for (var i = 0; i < attendance.length; i++) {
                if (attendance[i] != undefined) {
                    var record = attendance[i] as ZKTecoAttendance;
                    if (record.userId === this.userId) {
                        toReturn.push(record);
                    }
                }
            }
        }

        return toReturn;

    }

    public async getTemplates(): Promise<ZKTecoFinger[]> {
        var toReturn: ZKTecoFinger[] = [];

        var templates: ZKTecoFinger[] = await this.client.getTemplates();

        if (templates != undefined) {
            for (var i = 0; i < templates.length; i++) {
                if (templates[i] != undefined) {
                    var template = templates[i] as ZKTecoFinger;
                    if (template.uid === this.uid) {
                        toReturn.push(template);
                    }
                }
            }
        }

        return toReturn;
    }

    public toString(): string {
        return `UID: ${this.uid}, Role: ${this.role}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, Group ID: ${this.groupId}, User ID: ${this.userId}`;
    }
    
    public toStringWithRawData(): string {
        return `UID: ${this.uid}, Role: ${this.role}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, Group ID: ${this.groupId}, User ID: ${this.userId}, Raw Data: ${this.rawData}`;
    }

}

export { ZKTecoUser };