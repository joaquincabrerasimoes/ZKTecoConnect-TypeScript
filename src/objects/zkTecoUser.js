"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZKTecoUser = void 0;
class ZKTecoUser {
    constructor(uid, privilege, password, name, card, groupId, userId, client) {
        this.rawData = '';
        this.uid = uid;
        this.privilege = privilege;
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
        return `UID: ${this.uid}, Privilege: ${this.privilege}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, Group ID: ${this.groupId}, User ID: ${this.userId}`;
    }
    toStringWithRawData() {
        return `UID: ${this.uid}, Privilege: ${this.privilege}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, Group ID: ${this.groupId}, User ID: ${this.userId}, Raw Data: ${this.rawData}`;
    }
}
exports.ZKTecoUser = ZKTecoUser;
//# sourceMappingURL=zkTecoUser.js.map