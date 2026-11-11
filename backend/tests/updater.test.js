// Tests for backend/src/updater.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Updater = require('../src/updater');

/**
 * A project directory with a compose file and a git checkout in it, like the
 * host project a container sees at /app/host-project.
 */
function tempProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdns-updater-'));
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), COMPOSE_FILE);
    fs.mkdirSync(path.join(dir, '.git'));
    return dir;
}

// The local compose file, which the update has to keep.
const COMPOSE_FILE = 'services:\n  tdns-stats:\n    build: .\n';

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
function makeUpdater(answers = {}, exists = {}, projectRoot = '/tmp/project') {
    const calls = [];
    const execFn = async (command, options) => {
        calls.push({ command, options });
        const answer = answers[command];
        if (typeof answer === 'function') return { stdout: answer(command), stderr: '' };
        if (answer instanceof Error) throw answer;
        return { stdout: answer ?? '', stderr: '' };
    };
    const existsFn = path => !!exists[path];
    return { updater: new Updater(projectRoot, execFn, existsFn), calls };
}

/**
 * A project directory with a package file and the dependency folder the
 * project used to keep, like an install that has not been updated yet.
 *
 * `installed` says which dependencies are on the machine.
 */
function tempInstall(installed = ['express']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdns-install-'));
    const dependencies = {};
    for (const name of installed) dependencies[name] = '^4.18.2';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tdns-stats', dependencies }));

    for (const name of installed) {
        const folder = path.join(dir, 'backend', 'node_modules', name);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version: '4.18.2' }));
    }
    return dir;
}

// The command the updater runs to install the dependencies.
const INSTALL = 'npm install --omit=dev --no-audit --no-fund --prefer-offline';

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

    test.describe('docker update', () => {
        test.it('pulls the new code from git and rebuilds the container', async t => {
            const project = tempProject();
            t.after(() => {
                delete process.env.HOST_PROJECT_PATH;
                fs.rmSync(project, { recursive: true, force: true });
            });
            process.env.HOST_PROJECT_PATH = project;

            const compose = path.join(project, 'docker-compose.yml');
            const { updater, calls } = makeUpdater({
                // A real reset puts the committed file back, which would lose
                // a compose file the owner had edited.
                'git reset --hard origin/master': () => {
                    fs.writeFileSync(compose, 'services:\n  tdns-stats:\n    build: .\n    image: other\n');
                    return 'HEAD is now at 38a96a3';
                },
            });

            await updater.updateDocker();

            const commands = calls.map(c => c.command);

            assert.ok(commands.includes('git fetch origin'), 'the host project is fetched');
            assert.ok(commands.includes('git reset --hard origin/master'), 'the host project is reset to master');
            assert.ok(
                commands.includes(`docker compose -p tdns-stats -f ${compose} up -d --build`),
                'the container is rebuilt and started again',
            );

            // The git commands run in the host project directory.
            assert.equal(calls.find(c => c.command === 'git fetch origin').options.cwd, project);

            // The owner's own compose file survives the update.
            assert.equal(fs.readFileSync(compose, 'utf8'), COMPOSE_FILE);
        });

        test.it('fails when the rebuild fails', async t => {
            const project = tempProject();
            t.after(() => {
                delete process.env.HOST_PROJECT_PATH;
                fs.rmSync(project, { recursive: true, force: true });
            });
            process.env.HOST_PROJECT_PATH = project;

            const compose = path.join(project, 'docker-compose.yml');
            const { updater, calls } = makeUpdater({
                [`docker compose -p tdns-stats -f ${compose} up -d --build`]: new Error('the build failed'),
            });

            await assert.rejects(() => updater.updateDocker(), /the build failed/);

            // The code was already pulled, so the dashboard can be rebuilt by hand.
            const commands = calls.map(c => c.command);
            assert.ok(commands.includes('git reset --hard origin/master'));
        });
    });

    test.describe('systemd update', () => {
        test.it('pulls the new code and restarts the service', async () => {
            const { updater, calls } = makeUpdater({ 'git pull origin master': 'Already up to date.\n' });

            await updater.updateSystemd();

            const commands = calls.map(c => c.command);
            assert.ok(commands.includes('git fetch --tags --force origin'));
            assert.ok(commands.includes('git pull origin master'));
            assert.ok(commands.includes(INSTALL), 'the dependencies are installed');
            assert.ok(commands.includes('systemctl restart tdns-stats'));

            // The pull happens in the project directory.
            const pull = calls.find(c => c.command === 'git pull origin master');
            assert.equal(pull.options.cwd, '/tmp/project');

            // The dependencies are installed before the service is restarted.
            assert.ok(commands.indexOf(INSTALL) < commands.indexOf('systemctl restart tdns-stats'));
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

    test.describe('dependency install', () => {
        test.it('installs dependencies and clears the folder the project used to keep', async t => {
            const dir = tempInstall();
            t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

            const { updater, calls } = makeUpdater(
                {},
                {
                    [path.join(dir, 'backend', 'node_modules')]: true,
                    [path.join(dir, 'backend', 'node_modules', 'express', 'package.json')]: true,
                },
                dir,
            );

            await updater.updateSystemd();

            const commands = calls.map(c => c.command);
            assert.ok(commands.includes(INSTALL), 'the dependencies are installed');

            // The install runs in the project directory, next to the package file.
            assert.equal(calls.find(c => c.command === INSTALL).options.cwd, dir);

            // The folder the project used to keep is gone, so node looks in the
            // root and finds the versions that were just installed.
            assert.equal(fs.existsSync(path.join(dir, 'backend', 'node_modules')), false);
        });

        test.it('goes on when the dependencies are there and stops when one is missing', async t => {
            const dir = tempInstall();
            t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

            const exists = {
                [path.join(dir, 'backend', 'node_modules')]: true,
                [path.join(dir, 'backend', 'node_modules', 'express', 'package.json')]: true,
            };

            // The install fails, but the service can still start with the
            // dependencies it already has.
            const working = makeUpdater({ [INSTALL]: new Error('the registry is out of reach') }, exists, dir);

            await working.updater.updateSystemd();

            assert.ok(working.calls.map(c => c.command).includes('systemctl restart tdns-stats'));

            // The install fails and a dependency the project needs is not on
            // the machine, so the service is left running the old code.
            const broken = tempInstall(['express']);
            t.after(() => fs.rmSync(broken, { recursive: true, force: true }));
            fs.writeFileSync(
                path.join(broken, 'package.json'),
                JSON.stringify({ name: 'tdns-stats', dependencies: { express: '^4.18.2', 'js-yaml': '^4.1.0' } }),
            );

            const failing = makeUpdater(
                { [INSTALL]: new Error('the registry is out of reach') },
                {
                    [path.join(broken, 'backend', 'node_modules')]: true,
                    [path.join(broken, 'backend', 'node_modules', 'express', 'package.json')]: true,
                },
                broken,
            );

            await assert.rejects(() => failing.updater.updateSystemd(), /Dependencies are missing/);
            assert.ok(!failing.calls.map(c => c.command).includes('systemctl restart tdns-stats'));
        });
    });
});
