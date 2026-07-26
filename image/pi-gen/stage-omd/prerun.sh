#!/bin/bash -e
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# Start from the previous stage's rootfs (stage2 = Raspberry Pi OS Lite) instead of
# bootstrapping again. Every pi-gen stage that builds ON another one needs this; without it
# ${ROOTFS_DIR} is empty and the substage's apt/chroot steps have nothing to run against.

if [ ! -d "${ROOTFS_DIR}" ]; then
	copy_previous
fi
