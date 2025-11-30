import { ZKTecoClient } from '../src/index.js';
import { USER_DEFAULT } from '../src/others/constants.js';

async function main() {
    const ip = process.argv[2] || '192.168.1.201'; // Default IP
    const port = parseInt(process.argv[3] || '4370');

    console.log(`Connecting to ${ip}:${port}...`);
    const zk = new ZKTecoClient(ip, port, 5000, 0, false, true);

    try {
        const connected = await zk.connect();
        if (!connected) {
            console.error('Failed to connect');
            return;
        }
        console.log('Connected!');

        // 1. Initialize users to set up nextUid_
        console.log('Reading users to initialize counters...');
        const users = await zk.getUsers();
        console.log(`Found ${users.length} users.`);

        // 2. Create a new user with auto-ID (uid=0)
        console.log('Creating new user with uid=0 (auto-assign)...');
        const name = 'TestUser';
        const password = '123';
        const success = await zk.setUser(0, name, USER_DEFAULT, password, '', '', 0);

        if (success) {
            console.log('User created successfully!');

            // 3. Verify user exists
            console.log('Verifying user creation...');
            const newUsers = await zk.getUsers();
            const createdUser = newUsers.find(u => u.name === name);

            if (createdUser) {
                console.log(`User found: UID=${createdUser.uid}, UserID=${createdUser.userId}`);

                // 4. Clean up
                console.log('Deleting test user...');
                const deleteSuccess = await zk.deleteUser(createdUser.uid);
                if (deleteSuccess) {
                    console.log('User deleted successfully.');
                } else {
                    console.error('Failed to delete user.');
                }
            } else {
                console.error('User not found after creation!');
            }
        } else {
            console.error('Failed to create user.');
        }

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await zk.disconnect();
    }
}

main();
