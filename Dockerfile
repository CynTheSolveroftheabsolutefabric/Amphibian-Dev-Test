# syntax=docker/dockerfile:1.7
# Amphibian Launcher - build & run in Docker (works on macOS)
# The game's WASM toolchain (emsdk / ikvmc statics) is Linux-only, so on a Mac
# we build inside a Debian-based .NET 10 container pinned to linux/amd64
# (Docker Desktop's Rosetta emulation runs it fine on Apple Silicon).
#
# Build:  docker build --platform linux/amd64 -t amphibian .
# Run:    docker run --rm -it -p 5021:5021 --platform linux/amd64 amphibian
# Open:   https://localhost:5021  (Chrome or Edge only - not Safari/Firefox)
#
# BuildKit cache mounts keep the apt lists, pnpm store, NuGet cache, downloaded
# statics, and .NET intermediates between builds. The first build still has to
# download the ~430 MB statics and run the wasm toolchain.

FROM --platform=linux/amd64 mcr.microsoft.com/dotnet/sdk:10.0

ENV DEBIAN_FRONTEND=noninteractive \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1

# mono (runs ikvmc), a JDK, Node 24 + pnpm (frontend), plus Makefile utilities
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
        wget unzip make python3 curl ca-certificates \
        mono-devel openjdk-17-jdk-headless \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@10.34.9

WORKDIR /app

# Frontend dependencies first, so editing source does not re-install them.
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/
COPY vendor/dreamland-0.1.3.tgz vendor/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    cd frontend && pnpm install --frozen-lockfile

COPY . .

# .NET WebAssembly workload (big download; NuGet packages are cached)
RUN --mount=type=cache,target=/root/.nuget/packages,sharing=locked \
    cd loader && dotnet workload restore

ARG AOT=false
ARG OPT=false

# Full backend build: downloads the prebuilt statics, compiles the ikvmc
# bundles + dotnet-wasm runtime, and copies them into frontend/public.
RUN --mount=type=cache,target=/root/.nuget/packages,sharing=locked \
    --mount=type=cache,target=/app/statics,sharing=locked \
    --mount=type=cache,target=/app/loader/bin,sharing=locked \
    --mount=type=cache,target=/app/loader/obj,sharing=locked \
    --mount=type=cache,target=/app/jars,sharing=locked \
    make build AOT="$AOT" OPT="$OPT"

EXPOSE 5021
CMD ["pnpm", "--dir", "frontend", "run", "dev"]
