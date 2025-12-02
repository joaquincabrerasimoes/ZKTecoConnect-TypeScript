"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZKAttendanceIDMethod = exports.ZKSound = exports.ZKTecoAttendance = exports.ZKTecoUser = exports.ZKTecoClient = void 0;
var zkTecoClient_1 = require("./objects/zkTecoClient");
Object.defineProperty(exports, "ZKTecoClient", { enumerable: true, get: function () { return zkTecoClient_1.ZKTecoClient; } });
var zkTecoUser_1 = require("./objects/zkTecoUser");
Object.defineProperty(exports, "ZKTecoUser", { enumerable: true, get: function () { return zkTecoUser_1.ZKTecoUser; } });
var zkTecoAttendance_1 = require("./objects/zkTecoAttendance");
Object.defineProperty(exports, "ZKTecoAttendance", { enumerable: true, get: function () { return zkTecoAttendance_1.ZKTecoAttendance; } });
var enums_1 = require("./others/enums");
Object.defineProperty(exports, "ZKSound", { enumerable: true, get: function () { return enums_1.ZKSound; } });
Object.defineProperty(exports, "ZKAttendanceIDMethod", { enumerable: true, get: function () { return enums_1.ZKAttendanceIDMethod; } });
__exportStar(require("./others/interfaces"), exports);
__exportStar(require("./others/constants"), exports);
//# sourceMappingURL=index.js.map