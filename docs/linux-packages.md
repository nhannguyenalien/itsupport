# Linux package installation and temperature

ITSupport exposes `package.status`, `package.install`, and `system.temperature` for Linux device chats. Package management currently supports Debian, Ubuntu, and Proxmox with apt/dpkg. Other distributions return a clear unsupported/error result.

`package.install` is high risk and always creates a human approval, including when autonomy is enabled. Each proposal names one repository package; dependencies may be installed too. The agent uses fixed executables and validated arguments, checks an apt simulation for removals/upgrades and exact package resolution, and runs with `--no-remove --no-upgrade --no-install-recommends`. It does not refresh repositories, run a system upgrade, accept package URLs, or run arbitrary shell. Changes to repositories/package state between simulation and installation remain an apt concurrency limitation. Installed packages are returned without reinstalling. After installation, the backend independently queues `package.status`; verification only passes if `installed` is true.

Temperature readings come from hwmon (thermal zones as fallback). CPU sensors are distinguished from NVMe/chipset readings. No sensors-detect, module loading, or fan changes occur. Missing hardware sensors produce an explicit error; installing lm-sensors alone cannot guarantee hardware support.

Package execution has a 9-minute command limit, plus a 1-minute simulation and lock wait. Daemon IPC permits 12 minutes, and the AI workflow keeps polling for up to 15 minutes. On failures inspect actual package state before retrying; package installation is not transactional.

Deployment: rebuild Linux amd64/arm64 executor and daemon downloads, update existing agents and restart only ITSupport services. No database migration. Roll back the backend image and saved agent binaries if existing diagnostics fail. Validation covers approval with autonomy on/off, name injection, simulated unsafe plans, installed-package idempotence, temperature fixtures, and package verification state. Live tests must not install packages without the user's approval.
