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
            const created = await zk.setUser(101, 'Testing 3', 0, '9988', '1', '167', 0);
            console.log('Created:', created);
            const users = await zk.getUsers();
            console.log('Users:', users.map(user => user.toString()));
            const deleted = await zk.deleteUser(101);
            console.log('Deleted:', deleted);
            const users2 = await zk.getUsers();
            console.log('Users2:', users2.map(user => user.toString()));
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