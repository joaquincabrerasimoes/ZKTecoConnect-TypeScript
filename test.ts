import { ZKTeco } from './src/index.js';

async function test() {
    const zk = new ZKTeco('192.168.0.233', 4371, 5000, 69420, false, true);
    try {
        console.log('Connecting...');
        const connected = await zk.connect();
        console.log('Connected:', connected);

        if (connected) {
            const deviceInfo = await zk.getDeviceInfo();
            console.log('Device Info:', deviceInfo);

            const users = await zk.getUsers();
            console.log('Users count:', users.length);
            if (users.length > 0) {
                console.log('First 3 users:');
                for (let i = 0; i < Math.min(3, users.length); i++) {
                    console.log(`  ${i + 1}.`, users[i]);
                }
            }

            const attendance = await zk.getAttendance();
            console.log('Attendance records:', attendance.length);
            console.log('First 10 records:');
            for (let i = 0; i < Math.min(10, attendance.length); i++) {
                console.log(`  ${i + 1}.`, attendance[i]);
            }

            const template = await zk.getTemplates();
            console.log('Template 1:', template[0]);
            console.log('Template 2:', template[1]);
            console.log('Template 3:', template[2]);

            const userTemplate = await zk.getUserTemplate(3);
            console.log('User Template:', userTemplate);

            await zk.disconnect();
            console.log('Disconnected');
        }
    } catch (e) {
        console.error('Error:', e);
    }
}

test();