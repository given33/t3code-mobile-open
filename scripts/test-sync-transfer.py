"""Offline deployment helper smoke tests. Never connects to a real peer."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

helper = Path(__file__).resolve().parents[1] / 'deploy' / 'cloud' / 't3-sync-transfer.py'
spec = importlib.util.spec_from_file_location('relay_transfer', helper)
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


class TransferTests(unittest.TestCase):
    def test_exchange_and_ack(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'task-sync' / 'wire'
            def call(verb, packet):
                result = subprocess.run([sys.executable, '-I', str(helper), tmp],
                                        input=json.dumps(packet).encode(), stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=8,
                                        env=dict(os.environ, SSH_ORIGINAL_COMMAND=verb))
                self.assertEqual(result.returncode, 0)
                return json.loads(result.stdout)
            msg = {'from': 'local', 'to': 'cloud', 'message': {'kind': 'renew', 'seq': 2}}
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                task = pool.submit(call, 't3-sync-v1', msg)
                end = time.monotonic() + 3
                while time.monotonic() < end:
                    paths = list((root / 'incoming').glob('*.json'))
                    if paths:
                        break
                    time.sleep(0.03)
                self.assertEqual(len(paths), 1)
                self.assertEqual(json.loads(paths[0].read_bytes()), msg)
                ack = {'ok': True, 'value': {'status': 'renewed', 'seq': 2}}
                transfer.store(root / 'replies' / paths[0].name, ack)
                self.assertEqual(task.result(), ack)
            self.assertFalse(paths[0].exists())
            name = paths[0].name
            transfer.store(root / 'outgoing' / name, msg)
            self.assertEqual(call('t3-sync-fetch', None), {'id': name, 'request': msg})
            self.assertTrue(call('t3-sync-answer', {'id': name, 'reply': ack}))
            self.assertEqual(json.loads((root / 'answers' / name).read_bytes()), ack)
            with self.assertRaises(ValueError):
                transfer.exchange(root, {'arbitrary': 'command'})
            self.assertFalse(transfer.answer(root, {'id': '../outside', 'reply': 'unsafe'}))
            refused = subprocess.run([sys.executable, '-I', str(helper), tmp],
                                     env=dict(os.environ, SSH_ORIGINAL_COMMAND='invalid'),
                                     capture_output=True, timeout=2)
            self.assertNotEqual(refused.returncode, 0)
            self.assertFalse(refused.stdout)


    @unittest.skipUnless(sys.platform.startswith('linux'), 'renameat2 exchange is Linux-only')
    def test_offline_native_handoff_upgrade_and_rollback(self):
        for source, target in [('0.2.0', '0.3.0'), ('0.3.0', '0.4.0')]:
            with self.subTest(source=source, target=target):
                self.assert_offline_exchange(source, target)

    def assert_offline_exchange(self, source, target):
        upgrade = helper.with_name('offline-upgrade.py')
        with tempfile.TemporaryDirectory() as root:
            base = Path(root).resolve()
            release = base / 'mobile-link-release.fixture'
            old = base / 'userdata/plugins'
            stage = release / 'stage/userdata/plugins'
            for directory, version in [(old, source), (stage, target)]:
                package = directory / 'packages/t3-mobile-link'
                package.mkdir(parents=True)
                (package / 'package.json').write_text(json.dumps({'version': version}))
            config = {'actions': False, 'taskSync': {'enabled': False}}
            row = {'id': 't3-mobile-link', 'version': source, 'linked': False, 'enabled': True,
                   'installPath': str(old / 'packages/t3-mobile-link'), 'config': config}
            other = {'id': 'unrelated', 'config': {'enabled': True}}
            registry = old / 'registry.json'
            previous = json.dumps([other, row]).encode()
            registry.write_bytes(previous)
            state = old / 'state/t3-mobile-link'
            state.mkdir(parents=True)
            sentinel = state / 'marker'
            sentinel.write_text('preserve')
            def apply(verb):
                subprocess.run([sys.executable, '-I', str(upgrade), verb, str(base), str(release)],
                               check=True, capture_output=True)
            apply('apply')
            installed = json.loads(registry.read_bytes())
            self.assertEqual(installed[0], other)
            self.assertEqual(installed[1]['version'], target)
            self.assertEqual(installed[1]['config'], config)
            self.assertEqual(json.loads((old / 'packages/t3-mobile-link/package.json').read_text())['version'], target)
            self.assertEqual(sentinel.read_text(), 'preserve')
            apply('rollback')
            self.assertEqual(registry.read_bytes(), previous)
            self.assertEqual(json.loads((old / 'packages/t3-mobile-link/package.json').read_text())['version'], source)
            self.assertEqual(sentinel.read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
