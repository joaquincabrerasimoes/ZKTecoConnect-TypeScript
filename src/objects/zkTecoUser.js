import { ZKTecoClient } from "./zkTecoClient.js";
import { ZKTecoAttendance } from './zkTecoAttendance.js';
class ZKTecoUser {
    uid;
    role;
    password;
    name;
    card;
    groupId;
    userId;
    client;
    rawData = '';
    constructor(uid, role, password, name, card, groupId, userId, client) {
        this.uid = uid;
        this.role = role;
        this.password = password;
        this.name = name;
        this.card = card;
        this.groupId = groupId;
        this.userId = userId;
        this.client = client;
    }
    async getAttendance() {
        var toReturn = [];
        var attendance = await this.client.getAttendance();
        if (attendance != undefined) {
            for (var i = 0; i < attendance.length; i++) {
                if (attendance[i] != undefined) {
                    var record = attendance[i];
                    if (record.userId === this.userId) {
                        toReturn.push(record);
                    }
                }
            }
        }
        return toReturn;
    }
    async getTemplates() {
        var toReturn = [];
        var templates = await this.client.getTemplates();
        if (templates != undefined) {
            for (var i = 0; i < templates.length; i++) {
                if (templates[i] != undefined) {
                    var template = templates[i];
                    if (template.uid === this.uid) {
                        toReturn.push(template);
                    }
                }
            }
        }
        return toReturn;
    }
    toString() {
        return `UID: ${this.uid}, Role: ${this.role}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, Group ID: ${this.groupId}, User ID: ${this.userId}`;
    }
    toStringWithRawData() {
        return `UID: ${this.uid}, Role: ${this.role}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, Group ID: ${this.groupId}, User ID: ${this.userId}, Raw Data: ${this.rawData}`;
    }
}
export { ZKTecoUser };
//# sourceMappingURL=zkTecoUser.js.map