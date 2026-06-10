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
        this.capable = false;
    }

    async detectCapability() {
        const type = await this.detectDeploymentMethod();
        this.capable = type === 'docker'
            ? fs.existsSync('/app/host-project/docker-compose.yml')
            : type === 'systemd';
        return this.capable;
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
            const { stdout } = await execAsync("find / -maxdepth 5 -type f -name 'docker-compose.yml' 2>/dev/null | sort | head -n 20", { shell: '/bin/sh' });
            const paths = String(stdout).trim().split('\n').filter(Boolean);
            if (paths.length > 0) {
                const composeFile = paths[0];
                const hostProject = path.dirname(composeFile);
                return { hostProject, composeFile };
            }
        } catch (e) {
        }

        const checked = candidates.map(p => path.join(p, 'docker-compose.yml')).join(', ');
        throw new Error(`Docker compose file not found in any known mount path. Checked: ${checked}. Set HOST_PROJECT_PATH or TDNS_STATS_HOST_PROJECT_PATH to the mounted host project path.`);
    }

    async updateDocker() {
        const { hostProject, composeFile } = await this.findDockerComposePath();
        const cwd = hostProject;

        const composeCmd = await this.getDockerComposeCommand();
        console.log(`[update] Using compose command: ${composeCmd}`);
        console.log(`[update] Using host project path: ${hostProject}`);
        console.log(`[update] Using compose file: ${composeFile}`);

        if (await this.isGitRepo(cwd)) {
            console.log('[update] Updating host project repository from git');

            let composeContent = null;
            try {
                composeContent = fs.readFileSync(composeFile, 'utf-8');
            } catch (e) {
                console.warn('[update] Could not read docker-compose.yml for backup, continuing');
            }

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

            if (composeContent) {
                try {
                    fs.writeFileSync(composeFile, composeContent, 'utf-8');
                    console.log('[update] Restored local docker-compose.yml');
                } catch (e) {
                    console.warn('[update] Could not restore docker-compose.yml:', e.message);
                }
            }
        }

        try {
            const { stdout: pullStdout, stderr: pullStderr } = await execAsync(`${composeCmd} -p tdns-stats -f ${composeFile} pull`, { cwd, shell: '/bin/sh' });
            if (pullStderr) console.log('[update] docker compose pull stderr:', pullStderr);
            console.log('[update] Pull complete:', pullStdout);
        } catch (e) {
            console.error('[update] docker compose pull failed:', e.message);
            throw e;
        }

        console.log('[update] Scheduling compose restart from helper container');
        let helperImage = null;
        let helperHostSource = null;
        try {
            const { stdout: containerIdOut } = await execAsync('hostname', { shell: '/bin/sh' });
            const containerId = containerIdOut.trim();
            const { stdout: imageName } = await execAsync(`docker inspect --format='{{.Config.Image}}' ${containerId}`, { shell: '/bin/sh' });
            helperImage = imageName.trim();
            helperHostSource = await this.getHostMountSource(containerId, hostProject);
        } catch (e) {
        }

        const helperCmd = helperImage && helperHostSource
            ? `docker run --rm -d -v /var/run/docker.sock:/var/run/docker.sock -v ${helperHostSource}:${hostProject} -w ${hostProject} ${helperImage} sh -c '${composeCmd} -p tdns-stats -f ${composeFile} up -d --build'`
            : `${composeCmd} -p tdns-stats -f ${composeFile} up -d --build`; 

        try {
            const { stdout: helperStdout, stderr: helperStderr } = await execAsync(helperCmd, { cwd, shell: '/bin/sh' });
            if (helperStderr) console.log('[update] helper command stderr:', helperStderr);
            console.log('[update] Update triggered:', helperStdout.trim() || 'helper started');
        } catch (e) {
            console.error('[update] Failed to trigger helper restart:', e.message);
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
