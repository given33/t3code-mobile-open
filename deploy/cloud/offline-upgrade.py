#!/usr/bin/env python3
"""Offline Linux package exchange. Run as the service user ONLY while host is stopped.

Stage with the real host CLI in RELEASE/stage first. Keep RELEASE private and
on the same filesystem. No uninstall, state directory access or service changes.
"""
import ctypes
import datetime
import json
import os
import sys
from pathlib import Path

PLUGIN = 't3-mobile-link'


def exchange(a, b):
    lib = ctypes.CDLL(None, use_errno=True)
    fn = lib.renameat2
    if fn(-100, os.fsencode(str(a)), -100, os.fsencode(str(b)), 2) != 0:
        raise OSError(ctypes.get_errno(), 'Directory exchange failed')


def atomic(file, data):
    tmp = file.with_suffix('.upgrade-tmp')
    with tmp.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(str(tmp), str(file))


def run(base, release, revert):
    base, release = base.resolve(), release.resolve()
    if release.parent != base or not release.name.startswith('mobile-link-release.'):
        raise ValueError('Invalid release directory')
    old = base / 'userdata' / 'plugins'
    stage = release / 'stage' / 'userdata' / 'plugins'
    live, staged = [p / 'packages' / PLUGIN for p in [old, stage]]
    reg, backup = old / 'registry.json', release / 'registry-before.json'
    for p in [live, staged, reg]:
        if p.resolve() != p or p.stat().st_uid != os.geteuid():
            raise ValueError('Unexpected path or ownership')
    versions = [json.loads((p / 'package.json').read_text())['version'] for p in [live, staged]]
    transition = tuple(reversed(versions)) if revert else tuple(versions)
    if transition not in {('0.1.0', '0.2.0'), ('0.2.0', '0.3.0'), ('0.3.0', '0.4.0')}:
        raise ValueError('Unexpected versions; refusing exchange')
    data = reg.read_bytes()
    rows = json.loads(data)
    matches = [x for x in rows if x['id'] == PLUGIN]
    if len(matches) != 1 or matches[0]['version'] != versions[0] or matches[0]['linked'] or Path(matches[0]['installPath']).resolve() != live:
        raise ValueError('Unsupported installed entry')
    if revert:
        replacement = backup.read_bytes()  # immediate offline rollback only
    else:
        with backup.open('xb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        matches[0].update(version=versions[1], source=str(release / 'new.tgz'),
                          updatedAt=datetime.datetime.utcnow().isoformat() + 'Z')
        replacement = (json.dumps(rows, ensure_ascii=True, indent=2) + '\n').encode()
    exchange(live, staged)
    try:
        atomic(reg, replacement)
    except Exception:
        exchange(live, staged)
        raise
    for parent in [live.parent, staged.parent, reg.parent]:
        fd = os.open(str(parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 4 or sys.argv[1] not in ('apply', 'rollback'):
        sys.exit('Usage: offline-upgrade.py apply|rollback BASE RELEASE')
    run(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[1] == 'rollback')
