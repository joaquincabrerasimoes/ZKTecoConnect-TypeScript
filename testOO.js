import { ZKTecoClient } from './src/index.js';
async function test() {
    const zk = new ZKTecoClient('192.168.0.233', 4371, 5000, 69420, false, false);
    try {
        console.log('Connecting...');
        const connected = await zk.connect();
        console.log('Connected');
        if (connected) {
            const info = await zk.getMemoryInfo();
            console.log('Memory Info:', info);
            const users2 = await zk.getUsers();
            console.log('Users2:', users2.slice(0, 4).map(user => user.toStringWithRawData()));
            await zk.disconnect();
            console.log('Disconnected');
        }
    }
    catch (e) {
        console.error('Error:', e);
    }
}
test();
//# sourceMappingURL=testOO.js.map