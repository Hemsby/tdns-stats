'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const log = require('./log');

const execAsync = promisify(exec);

class Updater {
    constructor(projectRoot, execFn, existsFn) {
        this.projectRoot = projectRoot;
        this.execAsync = execFn || execAsync;
        // The filesystem is a dependency too, so a test can say which paths
        // exist without the answer depending on the machine it runs on.
        this.existsSync = existsFn || fs.existsSync;
        this.deploymentType = null;
        this.capable = false;
    }

    // ---- Running commands ------------------------------------------------------------
    /**
     * Run a command and give back what it printed.
     *
     * The shell is always /bin/sh, so a command behaves the same however the
     * updater was started.
     */
    async sh(command, options = {}) {
        const { stdout } = await this.execAsync(command, { shell: '/bin/sh', ...options });
        return String(stdout).trim();
    }

    /**
     * Run a command and write what it did to the debug log.
     *
     * An update that goes wrong is followed after the fact, so the output and
     * the errors of every step are kept.
     */
    async runLogged(label, command, options = {}) {
        const { stdout, stderr } = await this.execAsync(command, { shell: '/bin/sh', ...options });
        if (stderr) log.debug(`[update] ${label} stderr:`, stderr);
        log.debug(`[update] ${label}:`, String(stdout).trim());
        return stdout;
    }

    // ---- Deployment detection --------------------------------------------------------
    async detectCapability() {
        const type = await this.detectDeploymentMethod();
        this.capable = type === 'docker' ? this.existsSync('/app/host-project/docker-compose.yml') : type === 'systemd';
    }

    async detectDeploymentMethod() {
        if (this.deploymentType) return this.deploymentType;

        const deploymentTypeEnv = process.env.DEPLOYMENT_TYPE;
        if (deploymentTypeEnv && ['docker', 'systemd'].includes(deploymentTypeEnv)) {
            this.deploymentType = deploymentTypeEnv;
            return this.deploymentType;
        }

        if (this.existsSync('/.dockerenv')) {
            this.deploymentType = 'docker';
            return this.deploymentType;
        }

        const configPaths = ['/etc/tdns-stats/config.yml', ...(this.projectRoot ? [path.join(this.projectRoot, 'config.yml')] : [])];

        if (configPaths.some(p => this.existsSync(p))) {
            try {
                const state = await this.sh('systemctl is-active tdns-stats 2>/dev/null');
                if (state === 'active') {
                    this.deploymentType = 'systemd';
                    return this.deploymentType;
                }
            } catch (e) {}
            this.deploymentType = 'docker';
            return this.deploymentType;
        }

        this.deploymentType = null;
        return null;
    }

    // ---- Running the update ----------------------------------------------------------
    async executeUpdate() {
        const deploymentType = await this.detectDeploymentMethod();

        switch (deploymentType) {
            case 'docker':
                return this.updateDocker();
            case 'systemd':
                return this.updateSystemd();
            default:
                throw new Error('Updater not available for this deployment type');
        }
    }

    async getDockerComposeCommand() {
        try {
            await this.sh('command -v docker >/dev/null 2>&1');
            await this.sh('docker compose version >/dev/null 2>&1');
            return 'docker compose';
        } catch (e) {}

        try {
            await this.sh('command -v docker-compose >/dev/null 2>&1');
            return 'docker-compose';
        } catch (e) {}

        throw new Error('No docker compose command available in container');
    }

    async isGitRepo(dir) {
        return fs.existsSync(path.join(dir, '.git'));
    }

    async getHostMountSource(containerId, destination) {
        try {
            const stdout = await this.sh(
                `docker inspect --format='{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Source}}{{end}}{{end}}' ${containerId}`,
            );
            return stdout || null;
        } catch (e) {
            return null;
        }
    }

    async findDockerComposePath() {
        const envPath = process.env.TDNS_STATS_HOST_PROJECT_PATH || process.env.HOST_PROJECT_PATH;
        const candidates = [];
        if (envPath) candidates.push(envPath);
        candidates.push('/app/host-project', '/app', '/host-project', '/project');

        for (const candidate of candidates) {
            const composeFile = path.join(candidate, 'docker-compose.yml');
            if (fs.existsSync(composeFile)) {
                return { hostProject: candidate, composeFile };
            }
        }

        try {
            const paths = (await this.sh("find / -maxdepth 5 -type f -name 'docker-compose.yml' 2>/dev/null | sort | head -n 20"))
                .split('\n')
                .filter(Boolean);
            if (paths.length > 0) {
                const composeFile = paths[0];
                const hostProject = path.dirname(composeFile);
                return { hostProject, composeFile };
            }
        } catch (e) {}

        const checked = candidates.map(p => path.join(p, 'docker-compose.yml')).join(', ');
        throw new Error(
            `Docker compose file not found in any known mount path. Checked: ${checked}. ` +
                'Set HOST_PROJECT_PATH or TDNS_STATS_HOST_PROJECT_PATH to the mounted host project path.',
        );
    }

    async updateDocker() {
        const { hostProject, composeFile } = await this.findDockerComposePath();
        const cwd = hostProject;

        const composeCmd = await this.getDockerComposeCommand();
        log.debug(`[update] using compose command: ${composeCmd}`);
        log.debug(`[update] using host project path: ${hostProject}`);
        log.debug(`[update] using compose file: ${composeFile}`);

        if (await this.isGitRepo(cwd)) {
            log.debug('[update] updating host project repository from git');

            let composeContent = null;
            try {
                composeContent = fs.readFileSync(composeFile, 'utf-8');
            } catch (e) {
                console.warn('[update] could not read docker-compose.yml for backup, continuing');
            }

            try {
                await this.runLogged('fetched updates', 'git fetch origin', { cwd });
                await this.runLogged('reset host project to origin/master', 'git reset --hard origin/master', { cwd });
            } catch (e) {
                console.warn('[update] failed to update host git repository, continuing with compose rebuild:', e.message);
            }

            if (composeContent) {
                try {
                    fs.writeFileSync(composeFile, composeContent, 'utf-8');
                    log.debug('[update] restored local docker-compose.yml');
                } catch (e) {
                    console.warn('[update] could not restore docker-compose.yml:', e.message);
                }
            }
        }

        log.debug('[update] scheduling compose restart from helper container');
        let helperImage = null;
        let helperHostSource = null;
        try {
            const containerId = await this.sh('hostname');
            helperImage = await this.sh(`docker inspect --format='{{.Config.Image}}' ${containerId}`);
            helperHostSource = await this.getHostMountSource(containerId, hostProject);
        } catch (e) {}

        const extraMount = helperHostSource && helperHostSource !== hostProject ? `-v ${helperHostSource}:${helperHostSource}` : '';

        const helperCmd =
            helperImage && helperHostSource
                ? `docker run --rm -d \
                -v /var/run/docker.sock:/var/run/docker.sock \
                -v ${helperHostSource}:${hostProject} \
                ${extraMount} \
                -w ${hostProject} \
                ${helperImage} \
                sh -c '${composeCmd} -p tdns-stats -f ${composeFile} up -d --build'`
                : `${composeCmd} -p tdns-stats -f ${composeFile} up -d --build`;

        try {
            await this.runLogged('update triggered', helperCmd, { cwd });
        } catch (e) {
            console.error('[update] failed to trigger helper restart:', e.message);
            throw e;
        }
    }

    async updateSystemd() {
        const cwd = this.projectRoot;

        // Tags are only fetched so git describe shows the new version. A local tag that differs
        // from the remote one (a moved tag) makes a plain tag fetch fail, so force it and never
        // let a tag problem block the update itself.
        try {
            await this.sh('git fetch --tags --force origin', { cwd });
        } catch (e) {
            console.warn('[update] tag fetch failed, continuing with update:', e.message);
        }

        log.debug('[update] executing git pull');
        try {
            await this.runLogged('git pull complete', 'git pull origin master', { cwd });
        } catch (e) {
            console.error('[update] git pull failed:', e.message);
            throw e;
        }

        log.debug('[update] restarting systemd service');
        try {
            await this.runLogged('service restart triggered', 'systemctl restart tdns-stats');
        } catch (e) {
            console.error('[update] systemctl restart failed:', e.message);
            throw e;
        }
    }
}

module.exports = Updater;
