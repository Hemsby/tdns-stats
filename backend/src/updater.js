'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const log = require('./log');

const execAsync = promisify(exec);

class Updater {
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
        this.deploymentType = null;
        this.capable = false;
    }

    async detectCapability() {
        const type = await this.detectDeploymentMethod();
        this.capable = type === 'docker'
            ? fs.existsSync('/app/host-project/docker-compose.yml')
            : type === 'systemd';
    }

    async detectDeploymentMethod() {
        if (this.deploymentType) return this.deploymentType;

        const deploymentTypeEnv = process.env.DEPLOYMENT_TYPE;
        if (deploymentTypeEnv && ['docker', 'systemd'].includes(deploymentTypeEnv)) {
            this.deploymentType = deploymentTypeEnv;
            return this.deploymentType;
        }

        if (fs.existsSync('/.dockerenv')) {
            this.deploymentType = 'docker';
            return this.deploymentType;
        }

        const configPaths = [
            '/etc/tdns-stats/config.yml',
            ...(this.projectRoot ? [path.join(this.projectRoot, 'config.yml')] : [])
        ];

        if (configPaths.some(p => fs.existsSync(p))) {
            try {
                const result = await execAsync('systemctl is-active tdns-stats 2>/dev/null', { shell: '/bin/sh' });
                if (result.stdout.trim() === 'active') {
                    this.deploymentType = 'systemd';
                    return this.deploymentType;
                }
            } catch (e) {
            }
            this.deploymentType = 'docker';
            return this.deploymentType;
        }

        this.deploymentType = null;
        return null;
    }

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
            await execAsync('command -v docker >/dev/null 2>&1', { shell: '/bin/sh' });
            await execAsync('docker compose version >/dev/null 2>&1', { shell: '/bin/sh' });
            return 'docker compose';
        } catch (e) {
        }

        try {
            await execAsync('command -v docker-compose >/dev/null 2>&1', { shell: '/bin/sh' });
            return 'docker-compose';
        } catch (e) {
        }

        throw new Error('No docker compose command available in container');
    }

    async isGitRepo(dir) {
        return fs.existsSync(path.join(dir, '.git'));
    }

    async getHostMountSource(containerId, destination) {
        try {
            const { stdout } = await execAsync(
                `docker inspect --format='{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Source}}{{end}}{{end}}' ${containerId}`,
                { shell: '/bin/sh' }
            );
            return String(stdout).trim() || null;
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
            const { stdout } = await execAsync(
                "find / -maxdepth 5 -type f -name 'docker-compose.yml' 2>/dev/null | sort | head -n 20",
                { shell: '/bin/sh' }
            );
            const paths = String(stdout).trim().split('\n').filter(Boolean);
            if (paths.length > 0) {
                const composeFile = paths[0];
                const hostProject = path.dirname(composeFile);
                return { hostProject, composeFile };
            }
        } catch (e) {
        }

        const checked = candidates.map(p => path.join(p, 'docker-compose.yml')).join(', ');
        throw new Error(
            `Docker compose file not found in any known mount path. Checked: ${checked}. ` +
            `Set HOST_PROJECT_PATH or TDNS_STATS_HOST_PROJECT_PATH to the mounted host project path.`
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
                const { stdout: fetchStdout, stderr: fetchStderr } = await execAsync(
                    'git fetch origin', { cwd, shell: '/bin/sh' }
                );
                if (fetchStderr) log.debug('[update] git fetch stderr:', fetchStderr);
                log.debug('[update] fetched updates:', fetchStdout);

                const { stdout: resetStdout, stderr: resetStderr } = await execAsync(
                    'git reset --hard origin/master', { cwd, shell: '/bin/sh' }
                );
                if (resetStderr) log.debug('[update] git reset stderr:', resetStderr);
                log.debug('[update] reset host project to origin/master:', resetStdout);
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

        try {
            const { stdout: pullStdout, stderr: pullStderr } = await execAsync(
                `${composeCmd} -p tdns-stats -f ${composeFile} pull`, { cwd, shell: '/bin/sh' }
            );
            if (pullStderr) log.debug('[update] docker compose pull stderr:', pullStderr);
            log.debug('[update] pull complete:', pullStdout);
        } catch (e) {
            console.error('[update] docker compose pull failed:', e.message);
            throw e;
        }

        log.debug('[update] scheduling compose restart from helper container');
        let helperImage = null;
        let helperHostSource = null;
        try {
            const { stdout: containerIdOut } = await execAsync('hostname', { shell: '/bin/sh' });
            const containerId = containerIdOut.trim();
            const { stdout: imageName } = await execAsync(
                `docker inspect --format='{{.Config.Image}}' ${containerId}`, { shell: '/bin/sh' }
            );
            helperImage = imageName.trim();
            helperHostSource = await this.getHostMountSource(containerId, hostProject);
        } catch (e) {
        }

        const extraMount = (helperHostSource && helperHostSource !== hostProject)
            ? `-v ${helperHostSource}:${helperHostSource}`
            : '';

        const helperCmd = helperImage && helperHostSource
            ? `docker run --rm -d \
                -v /var/run/docker.sock:/var/run/docker.sock \
                -v ${helperHostSource}:${hostProject} \
                ${extraMount} \
                -w ${hostProject} \
                ${helperImage} \
                sh -c '${composeCmd} -p tdns-stats -f ${composeFile} up -d --build'`
            : `${composeCmd} -p tdns-stats -f ${composeFile} up -d --build`;

        try {
            const { stdout: helperStdout, stderr: helperStderr } = await execAsync(
                helperCmd, { cwd, shell: '/bin/sh' }
            );
            if (helperStderr) log.debug('[update] helper command stderr:', helperStderr);
            log.debug('[update] update triggered:', helperStdout.trim() || 'helper started');
        } catch (e) {
            console.error('[update] failed to trigger helper restart:', e.message);
            throw e;
        }
    }

    async updateSystemd() {
        const cwd = this.projectRoot;

        log.debug('[update] executing git pull');
        try {
            const { stdout: pullStdout, stderr: pullStderr } = await execAsync(
                'git pull origin master', { cwd, shell: '/bin/sh' }
            );
            if (pullStderr) log.debug('[update] git pull stderr:', pullStderr);
            log.debug('[update] git pull complete:', pullStdout);
        } catch (e) {
            console.error('[update] git pull failed:', e.message);
            throw e;
        }

        log.debug('[update] restarting systemd service');
        try {
            const { stdout: restartStdout, stderr: restartStderr } = await execAsync(
                'systemctl restart tdns-stats', { shell: '/bin/sh' }
            );
            if (restartStderr) log.debug('[update] systemctl stderr:', restartStderr);
            log.debug('[update] service restart triggered:', restartStdout);
        } catch (e) {
            console.error('[update] systemctl restart failed:', e.message);
            throw e;
        }
    }
}

module.exports = Updater;
