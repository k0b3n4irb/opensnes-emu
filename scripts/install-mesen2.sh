#!/usr/bin/env bash
# install-mesen2.sh — fetch the Mesen2 binary into ../vendor/
#
# Used by the Mesen2 visual-regression phase
# (test/phases/visual-mesen2.mjs). The phase auto-skips when the binary
# is missing, so this script only needs to be run by contributors who
# want CI-equivalent coverage for SuperFX / SA-1 ROMs.
#
# Usage:
#   tools/opensnes-emu/scripts/install-mesen2.sh [version]
#
# Default version is the value of MESEN_VERSION below. The downloaded
# binary is placed at tools/opensnes-emu/vendor/Mesen and marked
# executable. The version is recorded in vendor/.mesen-version so
# subsequent runs can short-circuit when the cached binary matches.

set -euo pipefail

MESEN_VERSION="${1:-2.1.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/../vendor"
BIN_PATH="${VENDOR_DIR}/Mesen"
VERSION_FILE="${VENDOR_DIR}/.mesen-version"

# Detect platform
ARCH="$(uname -m)"
OS="$(uname -s)"

case "${OS}-${ARCH}" in
    Linux-x86_64)   ASSET="Mesen_${MESEN_VERSION}_Linux_x64.zip" ;;
    Linux-aarch64)  ASSET="Mesen_${MESEN_VERSION}_Linux_ARM64.zip" ;;
    Darwin-x86_64)  ASSET="Mesen_${MESEN_VERSION}_macOS_x64_Intel.zip" ;;
    Darwin-arm64)   ASSET="Mesen_${MESEN_VERSION}_macOS_ARM64_AppleSilicon.zip" ;;
    *)
        echo "[install-mesen2] Unsupported platform: ${OS} ${ARCH}" >&2
        echo "  Supported: Linux x86_64/aarch64, macOS x86_64/arm64" >&2
        exit 1
        ;;
esac

# Skip if cached
if [[ -x "${BIN_PATH}" && -f "${VERSION_FILE}" ]]; then
    cached="$(cat "${VERSION_FILE}")"
    if [[ "${cached}" == "${MESEN_VERSION}-${ARCH}" ]]; then
        echo "[install-mesen2] Mesen ${MESEN_VERSION} already installed at ${BIN_PATH}"
        exit 0
    fi
fi

mkdir -p "${VENDOR_DIR}"
URL="https://github.com/SourMesen/Mesen2/releases/download/${MESEN_VERSION}/${ASSET}"
ARCHIVE="${VENDOR_DIR}/${ASSET}"

echo "[install-mesen2] Fetching ${ASSET} from GitHub..."
curl -sSfL "${URL}" -o "${ARCHIVE}"

echo "[install-mesen2] Extracting..."
# The zip contains a single file named "Mesen" at its root
unzip -o "${ARCHIVE}" -d "${VENDOR_DIR}" > /dev/null
chmod +x "${BIN_PATH}"
rm -f "${ARCHIVE}"

echo "${MESEN_VERSION}-${ARCH}" > "${VERSION_FILE}"

echo "[install-mesen2] Installed at ${BIN_PATH}"
echo "[install-mesen2] Run \`node test/run-all-tests.mjs --quick --phase mesen2\` to validate."
