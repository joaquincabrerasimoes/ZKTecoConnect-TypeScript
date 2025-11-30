import { ZKTecoClient } from "./zkTecoClient.js";
class ZKTecoUser {
    uid;
    role;
    password;
    name;
    card;
    userId;
    client;
    constructor(uid, role, password, name, card, userId, client) {
        this.uid = uid;
        this.role = role;
        this.password = password;
        this.name = name;
        this.card = card;
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
        return `UID: ${this.uid}, Role: ${this.role}, Password: ${this.password}, Name: ${this.name}, Card: ${this.card}, User ID: ${this.userId}`;
    }
}
export { ZKTecoUser };
//# sourceMappingURL=zkTecoUser.js.map