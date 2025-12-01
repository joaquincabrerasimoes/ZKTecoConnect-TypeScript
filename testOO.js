import { ZKTecoClient } from './src/index.js';
import { ZKAttendanceIDMethod } from './src/others/enums.js';
async function testLiveEvents() {
    const zk = new ZKTecoClient('192.168.0.233', 4371, 5000, 69420, false, true);
    try {
        console.log('Connecting...');
        const connected = await zk.connect();
        if (!connected) {
            console.error('Unable to connect to device');
            return;
        }
        console.log('Connected');
        const memory = await zk.getMemoryInfo();
        console.log('Memory Info:', memory);
        //get templates from user 3
        var user = await zk.getUser(3);
        if (user) {
            var templates = await user.getTemplates();
            console.log('Templates:', templates);
        }
    }
    catch (error) {
        console.error('Live capture test failed:', error);
    }
    finally {
        await zk.disconnect();
        console.log('Disconnected');
    }
}
testLiveEvents();
//# sourceMappingURL=testOO.js.map