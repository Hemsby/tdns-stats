// Tests for backend/src/updater.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Updater = require('../src/updater');

/**
 * An updater with a shell that answers from a table.
 *
 * The updater takes the shell as a dependency, so the commands it would run
 * can be read without running any of them.
 *
 * `exists` says which paths are on the machine. The updater looks for the
 * config in /etc/tdns-stats/config.yml and in the project root, and a
 * development machine has the config in the project root rather than in /etc.
 */
function makeUpdater(answers = {}, exists = {}) {
    const calls = [];
    const execFn = async (command, options) => {
        calls.push({ command, options });
        const answer = answers[command];
        if (answer instanceof Error) throw answer;
        return { stdout: answer ?? '', stderr: '' };
    };
    const existsFn = path => !!exists[path];
    return { updater: new Updater('/tmp/project', execFn, existsFn), calls };
}

test.describe('backend/src/updater.js', () => {
    test.describe('shell', () => {
        test.it('runs a command with the shell and gives back what it printed', async () => {
            const { updater, calls } = makeUpdater({ 'git pull origin master': 'Already up to date.\n' });

            const output = await updater.sh('git pull origin master');

            assert.equal(output, 'Already up to date.');
            assert.equal(calls[0].options.shell, '/bin/sh');

            // The command runs in the directory it is given.
            await updater.sh('git fetch origin', { cwd: '/tmp/project' });

            assert.equal(calls[1].options.cwd, '/tmp/project');
        });

        test.it('reports a command that failed', async () => {
            const { updater } = makeUpdater({ 'git fetch origin': new Error('no such remote') });

            await assert.rejects(() => updater.sh('git fetch origin'), /no such remote/);
        });
    });

    test.describe('deployment', () => {
        test.it('takes the type from the environment and asks for that update', async t => {
            const { updater } = makeUpdater();
            t.after(() => {
                delete process.env.DEPLOYMENT_TYPE;
            });
            process.env.DEPLOYMENT_TYPE = 'docker';
            updater.updateDocker = async () => 'docker';

            assert.equal(await updater.detectDeploymentMethod(), 'docker');
            assert.equal(await updater.executeUpdate(), 'docker');
        });

        test.it('ignores an environment that says something else and refuses an update it cannot do', async t => {
            const { updater } = makeUpdater();
            t.after(() => {
                delete process.env.DEPLOYMENT_TYPE;
            });
            process.env.DEPLOYMENT_TYPE = 'kubernetes';

            assert.notEqual(await updater.detectDeploymentMethod(), 'kubernetes');

            const { updater: other } = makeUpdater();
            other.detectDeploymentMethod = async () => null;

            await assert.rejects(() => other.executeUpdate(), /not available/);
        });
    });

    test.describe('deployment detection', () => {
        test.it('finds the deployment from the files and the service that are there', async t => {
            t.after(() => {
                delete process.env.DEPLOYMENT_TYPE;
            });
            delete process.env.DEPLOYMENT_TYPE;

            // A machine with the config file and a running systemd service.
            const systemd = makeUpdater({ 'systemctl is-active tdns-stats 2>/dev/null': 'active' }, { '/etc/tdns-stats/config.yml': true });
            assert.equal(await systemd.updater.detectDeploymentMethod(), 'systemd');

            // The same machine without the service running: the update is done
            // with docker compose.
            const docker = makeUpdater(
                { 'systemctl is-active tdns-stats 2>/dev/null': 'inactive' },
                { '/etc/tdns-stats/config.yml': true },
            );
            assert.equal(await docker.updater.detectDeploymentMethod(), 'docker');

            // A container: the update is done with docker compose too.
            const container = makeUpdater({}, { '/.dockerenv': true });
            assert.equal(await container.updater.detectDeploymentMethod(), 'docker');

            // A machine with neither: there is nothing to update.
            const bare = makeUpdater({}, {});
            assert.equal(await bare.updater.detectDeploymentMethod(), null);
            await assert.rejects(() => bare.updater.executeUpdate(), /not available/);
        });

        test.it('knows whether it can update at all', async t => {
            t.after(() => {
                delete process.env.DEPLOYMENT_TYPE;
            });
            delete process.env.DEPLOYMENT_TYPE;

            // A systemd install can always update itself.
            const systemd = makeUpdater({ 'systemctl is-active tdns-stats 2>/dev/null': 'active' }, { '/etc/tdns-stats/config.yml': true });
            await systemd.updater.detectCapability();
            assert.equal(systemd.updater.capable, true);

            // A container can only update itself when the host project is mounted.
            const container = makeUpdater({}, { '/.dockerenv': true });
            await container.updater.detectCapability();
            assert.equal(container.updater.capable, false);

            const mounted = makeUpdater({}, { '/.dockerenv': true, '/app/host-project/docker-compose.yml': true });
            await mounted.updater.detectCapability();
            assert.equal(mounted.updater.capable, true);
        });
    });

    test.describe('systemd update', () => {
        test.it('pulls the new code and restarts the service', async () => {
            const { updater, calls } = makeUpdater({ 'git pull origin master': 'Already up to date.\n' });

            await updater.updateSystemd();

            const commands = calls.map(c => c.command);
            assert.ok(commands.includes('git fetch --tags --force origin'));
            assert.ok(commands.includes('git pull origin master'));
            assert.ok(commands.includes('systemctl restart tdns-stats'));

            // The pull happens in the project directory.
            const pull = calls.find(c => c.command === 'git pull origin master');
            assert.equal(pull.options.cwd, '/tmp/project');
        });

        test.it('still updates when the tags cannot be fetched', async () => {
            // A moved tag makes a plain tag fetch fail; that must not stop the update.
            const { updater, calls } = makeUpdater({
                'git fetch --tags --force origin': new Error('refusing to fetch a moved tag'),
                'git pull origin master': 'Already up to date.\n',
            });

            await updater.updateSystemd();

            const commands = calls.map(c => c.command);
            assert.ok(commands.includes('git pull origin master'));
            assert.ok(commands.includes('systemctl restart tdns-stats'));
        });
    });
});
