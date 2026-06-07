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
        const cwd = this.projectRoot;
        console.log('[update] Executing docker compose pull');
        const { stdout: pullStdout, stderr: pullStderr } = await execAsync('docker compose pull', { cwd, shell: '/bin/sh' });
        if (pullStderr) console.log('[update] docker-compose pull stderr:', pullStderr);
        console.log('[update] Pull complete:', pullStdout);

        console.log('[update] Executing docker compose up -d');
        const { stdout: upStdout, stderr: upStderr } = await execAsync('docker compose up -d', { cwd, shell: '/bin/sh' });
        if (upStderr) console.log('[update] docker-compose up stderr:', upStderr);
        console.log('[update] Update complete, container will be restarted:', upStdout);
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
