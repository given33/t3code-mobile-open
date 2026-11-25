#!/usr/bin/env python3
"""Dedicated-key relay spool. No shell, paths or commands accepted from the peer."""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

LIMIT = 48 * 1024 * 1024
ID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json\Z")


def read(stream):
    data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError()
    return json.loads(data)


def store(file, value):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=str(file.parent), delete=False) as f:
        name = f.name
        try:
            f.write(json.dumps(value, separators=(',', ':')).encode('utf8'))
            f.flush()
            os.fsync(f.fileno())
            f.close()
            os.replace(name, str(file))
        finally:
            if os.path.exists(name):
                os.unlink(name)


def discard(file):
    try:
        file.unlink()
    except FileNotFoundError:
        pass


def exchange(root, message):
    name = str(uuid.uuid4()) + '.json'
    incoming, reply = root / 'incoming' / name, root / 'replies' / name
    if not isinstance(message, dict) or set(message) != {'from', 'to', 'message'}:
        raise ValueError()
    store(incoming, message)
    try:
        end = time.monotonic() + 6
        while time.monotonic() < end:
            try:
                with reply.open('rb') as f:
                    return read(f)
            except FileNotFoundError:
                time.sleep(0.06)
        raise TimeoutError()
    finally:
        discard(incoming)
        discard(reply)


def fetch(root):
    for f in sorted((root / 'outgoing').glob('*.json')):
        if ID.fullmatch(f.name) and not f.is_symlink():
            try:
                with f.open('rb') as stream:
                    return {'id': f.name, 'request': read(stream)}
            except FileNotFoundError:
                continue
    return None


def answer(root, item):
    name = item['id']
    if not ID.fullmatch(name) or not (root / 'outgoing' / name).exists():
        return False
    store(root / 'answers' / name, item['reply'])
    return True


def remote(config, verb, message=None):
    # The forced command at the destination dispatches only these fixed verbs.
    args = ['ssh', '-T', '-F', config, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
            '-o', 'IdentitiesOnly=yes', '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no',
            '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=4', 'sync-peer', verb]
    with tempfile.TemporaryFile() as out:
        subprocess.run(args, input=json.dumps(message).encode(), stdout=out,
                       stderr=subprocess.DEVNULL, check=True, timeout=8)
        out.seek(0)
        return read(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('state_dir')
    parser.add_argument('--pump', metavar='SSH_CONFIG')
    args = parser.parse_args()
    state = Path(args.state_dir)
    if not state.is_absolute() or not state.is_dir():
        raise ValueError()
    root = state / 'task-sync' / 'wire'
    if args.pump:
        if not os.path.isabs(args.pump):
            raise ValueError()
        item = fetch(root)
        if item:
            answer(root, {'id': item['id'], 'reply': remote(args.pump, 't3-sync-v1', item['request'])})
        item = remote(args.pump, 't3-sync-fetch')
        if item:
            remote(args.pump, 't3-sync-answer', {'id': item['id'], 'reply': exchange(root, item['request'])})
        return
    verb = os.environ.get('SSH_ORIGINAL_COMMAND')
    if verb == 't3-sync-v1':
        value = exchange(root, read(sys.stdin.buffer))
    elif verb == 't3-sync-fetch':
        value = fetch(root)
    elif verb == 't3-sync-answer':
        value = answer(root, read(sys.stdin.buffer))
    else:
        raise ValueError()
    json.dump(value, sys.stdout, separators=(',', ':'))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        sys.exit('Transfer unavailable or rejected')
