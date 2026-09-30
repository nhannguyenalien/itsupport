"""Exercise the installer's remote flow without installing services on the test host."""
import base64
import contextlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'install-linux.sh'
CODE = SOURCE.read_text().split('<<\'PY\'\n')[-1].split('\nPY\n')[0]
GROUP = 'A' * 64
NODE = 'a' * 96

class RemoteInstallerTests(unittest.TestCase):
    def run_flow(self, existing=False, wrong_group=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            mesh = root / 'mesh'
            config = root / 'config.json'
            config.write_text(json.dumps({'backendUrl': 'https://api.test/api', 'deviceId': 'device', 'agentToken': 'secret'}))
            settings = ('MeshID=0x' + base64.b64decode(GROUP).hex().upper() + '\nMeshServer=wss://mesh.test:443/agent.ashx\n').encode()
            if existing:
                mesh.mkdir()
                (mesh / 'meshagent').touch()
                (mesh / 'meshagent.msh').write_bytes(b'MeshID=other\n' if wrong_group else settings)
            requests, installs, registrations = [], [], []
            def urlopen(req, timeout):
                requests.append(req.full_url)
                self.assertEqual(req.get_header('User-agent'), 'ITSupport-Agent/1.0')
                if req.full_url.startswith('https://api.test'):
                    self.assertEqual(req.get_header('Authorization'), 'Bearer secret')
                else:
                    self.assertIsNone(req.get_header('Authorization'))
                if '/remote-install?' in req.full_url:
                    self.assertTrue(req.full_url.endswith('arch=arm64'))
                    return io.BytesIO(json.dumps({'url': 'https://mesh.test/meshagents?id=26', 'settingsUrl': 'https://mesh.test/meshsettings?id=' + GROUP, 'server': 'https://mesh.test', 'group': GROUP}).encode())
                if '/meshsettings?' in req.full_url:
                    return io.BytesIO(settings)
                if '/remote-register' in req.full_url:
                    registrations.append(json.loads(req.data))
                return io.BytesIO(b'{}')
            def run(args, **kwargs):
                if '-fullinstall' in args:
                    installs.append(args)
                    mesh.mkdir()
                    (mesh / 'meshagent').touch()
                    (mesh / 'meshagent.msh').write_bytes(settings)
                return subprocess.CompletedProcess(args, 0)
            source = CODE.replace("pathlib.Path('/usr/local/mesh_services/meshagent')", 'pathlib.Path(' + repr(str(mesh)) + ')')
            with patch.object(sys, 'argv', ['installer', str(config), 'arm64']), patch.object(urllib.request, 'urlopen', side_effect=urlopen), patch.object(subprocess, 'run', side_effect=run), patch.object(subprocess, 'check_output', return_value=NODE), contextlib.redirect_stdout(io.StringIO()):
                exec(compile(source, str(SOURCE), 'exec'), {})
            self.assertEqual(len(installs), 0 if existing else 1)
            self.assertEqual(registrations, [{'nodeId': NODE}])
            self.assertEqual(any('/meshagents?' in url for url in requests), not existing)

    def test_new_install_downloads_and_registers(self):
        self.run_flow()

    def test_rerun_keeps_existing_mesh_identity(self):
        self.run_flow(existing=True)

    def test_foreign_mesh_is_not_overwritten(self):
        with self.assertRaisesRegex(ValueError, 'another server/group'):
            self.run_flow(existing=True, wrong_group=True)

if __name__ == '__main__':
    unittest.main()
