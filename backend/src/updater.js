'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class Updater {
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
        this.deploymentType = null;
    }

    async detectDeploymentMethod() {
        if (this.deploymentType) return this.deploymentType;

        const deploymentTypeEnv = process.env.DEPLOYMENT_TYPE;
        if (deploymentTypeEnv && ['git', 'docker', 'systemd'].includes(deploymentTypeEnv)) {
            this.deploymentType = deploymentTypeEnv;
            return this.deploymentType;
        }

        if (fs.existsSync('/.dockerenv')) {
            this.deploymentType = 'docker';
            return this.deploymentType;
        }

        if (fs.existsSync('/etc/tdns-stats/config.yml')) {
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

        this.deploymentType = 'git';
        return this.deploymentType;
    }

    async executeUpdate() {
        const deploymentType = await this.detectDeploymentMethod();

        switch (deploymentType) {
            case 'docker':
                return this.updateDocker();
            case 'systemd':
                return this.updateSystemd();
            case 'git':
            default:
                return this.updateGit();
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

    async updateGit() {
        const cwd = this.projectRoot;
        console.log('[update] Fetching from remote');
        const { stdout: fetchStdout, stderr: fetchStderr } = await execAsync('git fetch origin', { cwd, shell: '/bin/sh' });
        if (fetchStderr) console.log('[update] git fetch stderr:', fetchStderr);
        console.log('[update] Fetched updates:', fetchStdout);

        console.log('[update] Resetting to remote master');
        const { stdout: resetStdout, stderr: resetStderr } = await execAsync('git reset --hard origin/master', { cwd, shell: '/bin/sh' });
        if (resetStderr) console.log('[update] git reset stderr:', resetStderr);
        console.log('[update] Reset complete:', resetStdout);

        console.log('[update] Update complete, process will restart');
        process.exit(0);
    }

    async updateDocker() {
        const hostProject = '/app/host-project';
        const composeFile = path.join(hostProject, 'docker-compose.yml');
        const cwd = hostProject;

        if (!fs.existsSync(composeFile)) {
            throw new Error(`Docker compose file not found at ${composeFile}`);
        }

        const composeCmd = await this.getDockerComposeCommand();
        console.log(`[update] Using compose command: ${composeCmd}`);

        if (await this.isGitRepo(cwd)) {
            console.log('[update] Updating host project repository from git');
            try {
                const { stdout: fetchStdout, stderr: fetchStderr } = await execAsync('git fetch origin', { cwd, shell: '/bin/sh' });
                if (fetchStderr) console.log('[update] git fetch stderr:', fetchStderr);
                console.log('[update] Fetched updates:', fetchStdout);

                const { stdout: resetStdout, stderr: resetStderr } = await execAsync('git reset --hard origin/master', { cwd, shell: '/bin/sh' });
                if (resetStderr) console.log('[update] git reset stderr:', resetStderr);
                console.log('[update] Reset host project to origin/master:', resetStdout);
            } catch (e) {
                console.warn('[update] Failed to update host git repository, continuing with compose rebuild:', e.message);
            }
        }

        console.log('[update] Executing docker compose up -d --build');
        try {
            await execAsync(`${composeCmd} -p tdns-stats -f ${composeFile} up -d --build`, { cwd, shell: '/bin/sh' });
            console.log('[update] Docker compose up complete');
        } catch (e) {
            console.error('[update] docker compose up failed:', e.message);
            throw e;
        }
    }

    async updateSystemd() {
        const cwd = this.projectRoot;
        console.log('[update] Executing git pull');
        const { stdout: pullStdout, stderr: pullStderr } = await execAsync('git pull origin master', { cwd, shell: '/bin/sh' });
        if (pullStderr) console.log('[update] git pull stderr:', pullStderr);
        console.log('[update] Git pull complete:', pullStdout);

        console.log('[update] Restarting systemd service');
        const { stdout: restartStdout, stderr: restartStderr } = await execAsync('systemctl restart tdns-stats', { shell: '/bin/sh' });
        if (restartStderr) console.log('[update] systemctl stderr:', restartStderr);
        console.log('[update] Service restart triggered:', restartStdout);
    }
}

module.exports = Updater;
