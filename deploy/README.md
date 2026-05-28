# Docker deployment

This deployment ships Open Design as a single Alpine-based runtime image. The
daemon serves both the API and the built Next.js static export, so there is no
separate nginx container.

## Local compose

Before starting:

1. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

2. Generate a secure token:

   ```bash
   openssl rand -hex 32
   ```

3. Open `.env` in your editor, find `OD_API_TOKEN=`, and paste the generated token there.

Then pull and start the service:

```bash
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest docker compose pull
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design:latest docker compose up -d --no-build
```

Defaults:

- Host port: `127.0.0.1:7456` (`OPEN_DESIGN_PORT=8080` to publish on `127.0.0.1:8080`)
- Runtime data volume: `open_design_data` mounted at `/app/.od`
- Node heap cap: `--max-old-space-size=192`
- Compose memory cap: `384m` (`OPEN_DESIGN_MEM_LIMIT=256m` to override)

Do not publish the daemon directly on a public or shared LAN interface. The API is
unauthenticated for non-browser clients, so remote deployments should keep Compose
bound to localhost and put an authenticated reverse proxy, SSH tunnel, or VPN in
front of it.

When exposing the service through an authenticated public IP, domain, or reverse
proxy, set `OPEN_DESIGN_ALLOWED_ORIGINS` to the browser origins that should be
allowed to call `/api`:

```bash
OPEN_DESIGN_ALLOWED_ORIGINS=https://od.example.com,http://203.0.113.10:7456 docker compose up -d --no-build
```

Pin a specific published image with a digest instead of the mutable `latest` tag:

```bash
OPEN_DESIGN_IMAGE=docker.io/vanjayak/open-design@sha256:<digest> docker compose up -d --no-build
```
The image intentionally does not bundle Claude/Codex/Gemini CLI binaries. Keep
those outside the image, or build a separate private runtime layer if a server
deployment needs local code-agent CLIs installed in the container.

<<<<<<< Updated upstream
=======
## Local compose with Codex CLI

`Dockerfile.codex` is a private-runtime variant of the standard image that also
installs the OpenAI Codex CLI. It sets `CODEX_HOME=/home/open-design/.codex` so a
Compose volume can persist ChatGPT/device-code authentication across container
recreates.

The Codex compose file is local-only by default. Open Design binds to loopback
inside the container and `socat` publishes that listener to Docker's port mapper,
which avoids the hosted-mode `OD_API_TOKEN` guard while keeping the host publish
bound to `127.0.0.1`. Do not adapt this proxy pattern for a public interface
without adding an authenticated reverse proxy or changing the deployment to use
`OD_BIND_HOST=0.0.0.0` with a generated `OD_API_TOKEN`.

Project files are bind-mounted from `OPEN_DESIGN_PROJECTS_DIR` in `deploy/.env`
and appear as `/app/.od/projects` in the container. Copy `.env.example` to
`.env` and set `OPEN_DESIGN_PROJECTS_DIR=../../../openDesign/OD_workspace` or
another host path before starting the Codex compose variant. The entrypoint runs
Open Design and Codex as `OPEN_DESIGN_UID:OPEN_DESIGN_GID` (default `1000:1000`)
so generated files remain editable from the host. Override those values if your
local user has a different UID or GID.

The Codex compose variant also bind-mounts `SPILLI_PEM_HOST_PATH` (default
`${HOME}/.spilli/SpiLLI_Enterprise.pem`) read-only to
`/run/secrets/spilli/SpiLLI_Enterprise.pem`. Open Design uses that container
path as the default SpiLLI `.pem` setting until the user saves a different path.

This compose variant defaults `OD_CODEX_SANDBOX=danger-full-access` because
Codex's Linux `workspace-write` sandbox can reject shell execution from inside a
nested Docker runtime. The host publish remains bound to `127.0.0.1`; treat this
as a trusted local agent container, not a public deployment profile.

Start Open Design with Codex available on `PATH`:

```bash
cd deploy
docker compose -f docker-compose.codex.yml up -d --build open-design
```

Authenticate Codex in the persisted `codex_home` volume:

```bash
docker compose -f docker-compose.codex.yml run --rm codex-login
```

The login helper runs `codex login --device-auth`; follow the printed device-code
URL in your browser. You can confirm the saved auth state with:

```bash
docker compose -f docker-compose.codex.yml run --rm codex-status
```

Useful overrides:

```bash
CODEX_VERSION=0.131.0 docker compose -f docker-compose.codex.yml build
OPEN_DESIGN_PORT=8080 docker compose -f docker-compose.codex.yml up -d open-design
OPEN_DESIGN_UID=$(id -u) OPEN_DESIGN_GID=$(id -g) docker compose -f docker-compose.codex.yml up -d open-design
```

>>>>>>> Stashed changes
## Publish to Docker Hub

```bash
deploy/scripts/publish-images.sh --image_tag latest
```

Useful overrides:

```bash
IMAGE_NAMESPACE=your-dockerhub-user deploy/scripts/publish-images.sh --arch arm64
deploy/scripts/publish-images.sh --image docker.io/your-user/open-design:0.1.0
```

The script defaults to:

- `docker.io/vanjayak/open-design:<tag>`
- `linux/amd64,linux/arm64`
- `skopeo` push strategy with Docker credentials read from `~/.docker/config.json`
- preloading base images through `skopeo` to reduce Docker Hub pull flakiness

If `127.0.0.1:7890` is available and no proxy is already set, the script uses it
for registry access and passes `host.docker.internal:7890` into Docker builds. The
host-gateway alias is only added for builds that need this local proxy mapping.

### Colima swap helper for Apple Silicon

`deploy/scripts/prepare-colima-build-swap.sh` is for manual Docker image
publishing from an Apple Silicon macOS host that uses Colima as the Docker VM.
The helper is intentionally Apple Silicon-only because the failure mode it covers
is local arm64 Colima builds exhausting a small Linux VM while preparing
multi-arch images. It exits before touching Colima on non-macOS or
non-Apple-Silicon hosts.

Low-memory Colima VMs can run out of RAM during multi-arch image builds. The
helper checks the VM memory and swap status, then creates and enables a temporary
swap file only when the VM has no swap and less than 4 GiB of RAM. The 4 GiB
threshold is a conservative default for short-lived manual publishes on small
Colima profiles; raise `COLIMA_BUILD_SWAP_MEMORY_THRESHOLD_KIB` if larger builds
still OOM, or lower it if you only want swap for very small VMs.

Prefer increasing the Colima VM memory (`colima start --memory <GiB>` or the
profile config) when you want a persistent build machine. Use this helper when
you need a temporary, reversible boost for one manual publish without resizing
or recreating the VM.

Run it before a manual publish if Docker builds fail with out-of-memory errors,
or if `status` shows a small Colima VM with no swap. The swap remains active
until cleanup or VM restart, so use a shell trap for one-off sessions:

```bash
deploy/scripts/prepare-colima-build-swap.sh status
deploy/scripts/prepare-colima-build-swap.sh
trap 'deploy/scripts/prepare-colima-build-swap.sh cleanup' EXIT
deploy/scripts/publish-images.sh --image_tag latest
```

Useful overrides:

```bash
COLIMA_BUILD_SWAP_SIZE=6G deploy/scripts/prepare-colima-build-swap.sh
COLIMA_BUILD_SWAP_MEMORY_THRESHOLD_KIB=6291456 deploy/scripts/prepare-colima-build-swap.sh
COLIMA_BIN=/opt/homebrew/bin/colima deploy/scripts/prepare-colima-build-swap.sh status
COLIMA_BUILD_SWAP_CLEANUP_FORCE=1 COLIMA_BUILD_SWAPFILE=/custom-swapfile deploy/scripts/prepare-colima-build-swap.sh cleanup
```

`cleanup` removes the default helper path and the old helper path. If you set a
custom `COLIMA_BUILD_SWAPFILE`, cleanup refuses to remove it unless
`COLIMA_BUILD_SWAP_CLEANUP_FORCE=1` is also set.
