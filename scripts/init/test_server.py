"""Tests for the init server's bearer-token auth and loopback bind (C7).

Run:  python3 -m unittest scripts.init.test_server -v
  or: cd scripts/init && python3 -m unittest test_server -v

Stdlib-only on purpose — the init VM has bare python3.
"""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
TEST_TOKEN = "test-token-c7-0123456789abcdef"


def _load_server_module(name: str = "init_server_under_test"):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / "server.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ServerAuthTest(unittest.TestCase):
    """Every /api/* endpoint must require the bearer token."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        # Point the server at an isolated repo dir so tests never touch a real .env
        (Path(cls._tmp.name) / "scripts").mkdir()
        cls._old_env = {k: os.environ.get(k) for k in ("IW_REPO_DIR", "IW_INIT_TOKEN", "IW_HOST")}
        os.environ["IW_REPO_DIR"] = cls._tmp.name
        os.environ["IW_INIT_TOKEN"] = TEST_TOKEN
        cls.server_mod = _load_server_module()
        cls.httpd = cls.server_mod.ThreadedServer(("127.0.0.1", 0), cls.server_mod.Handler)
        cls.port = cls.httpd.server_address[1]
        cls._thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls._thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls._tmp.cleanup()
        for k, v in cls._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        sys.modules.pop("init_server_under_test", None)

    def _request(self, path: str, method: str = "GET", token: str = None, body: bytes = None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method, data=body)
        if token is not None:
            req.add_header("Authorization", f"Bearer {token}")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # -- unauthenticated access is rejected ---------------------------------

    def test_status_without_token_returns_401(self):
        status, body = self._request("/api/status")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body).get("error"), "unauthorized")

    def test_status_with_wrong_token_returns_401(self):
        status, _ = self._request("/api/status", token="wrong-token")
        self.assertEqual(status, 401)

    def test_kubeconfig_without_token_returns_401(self):
        status, body = self._request("/api/get-kubeconfig")
        self.assertEqual(status, 401)
        self.assertNotIn(b"kubeconfig", body.replace(b"unauthorized", b""))

    def test_load_env_without_token_returns_401(self):
        status, _ = self._request("/api/load-env")
        self.assertEqual(status, 401)

    def test_save_env_without_token_returns_401_and_writes_nothing(self):
        status, _ = self._request(
            "/api/save-env", method="POST",
            body=json.dumps({"env": "PWNED=1\nX=y\n"}).encode(),
        )
        self.assertEqual(status, 401)
        self.assertFalse((Path(self._tmp.name) / ".env").exists())

    def test_deploy_without_token_returns_401(self):
        status, _ = self._request("/api/deploy", method="POST", body=b"{}")
        self.assertEqual(status, 401)

    # -- authenticated access works ------------------------------------------

    def test_status_with_token_returns_200(self):
        status, body = self._request("/api/status", token=TEST_TOKEN)
        self.assertEqual(status, 200)
        self.assertIn("env_saved", json.loads(body))

    def test_load_env_with_token_returns_200(self):
        status, body = self._request("/api/load-env", token=TEST_TOKEN)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body).get("ok"))

    # -- deliberate exemptions -------------------------------------------------

    def test_health_is_public(self):
        status, body = self._request("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body).get("ok"))

    def test_ui_index_is_public(self):
        status, _ = self._request("/")
        self.assertEqual(status, 200)

    def test_options_preflight_is_public(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/status", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 204)
            self.assertIn("Authorization", resp.headers.get("Access-Control-Allow-Headers", ""))


class ServerConfigTest(unittest.TestCase):
    """Startup defaults: loopback bind, token generation, re-exec persistence."""

    def _reload_with_env(self, name: str, **env):
        old = {k: os.environ.get(k) for k in ("IW_HOST", "IW_INIT_TOKEN", "IW_REPO_DIR")}
        for k in old:
            os.environ.pop(k, None)
        os.environ.update(env)
        try:
            return _load_server_module(name)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            sys.modules.pop(name, None)

    def test_default_host_is_loopback(self):
        mod = self._reload_with_env("init_server_host_test")
        self.assertEqual(mod.HOST, "127.0.0.1")

    def test_host_env_override_still_works(self):
        mod = self._reload_with_env("init_server_host_override_test", IW_HOST="0.0.0.0")
        self.assertEqual(mod.HOST, "0.0.0.0")

    def test_token_generated_when_env_unset(self):
        mod = self._reload_with_env("init_server_token_test")
        self.assertGreaterEqual(len(mod.INIT_TOKEN), 32)

    def test_token_exported_to_environ_for_self_update_reexec(self):
        old = os.environ.get("IW_INIT_TOKEN")
        try:
            os.environ.pop("IW_INIT_TOKEN", None)
            mod = _load_server_module("init_server_reexec_test")
            self.assertEqual(os.environ.get("IW_INIT_TOKEN"), mod.INIT_TOKEN)
        finally:
            sys.modules.pop("init_server_reexec_test", None)
            if old is None:
                os.environ.pop("IW_INIT_TOKEN", None)
            else:
                os.environ["IW_INIT_TOKEN"] = old


class OutboundHostGuardTest(unittest.TestCase):
    """Proxmox credential-bearing calls must refuse arbitrary destinations (SSRF)."""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_server_module("init_server_hostguard_test")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("init_server_hostguard_test", None)

    def test_private_ip_allowed(self):
        for ip in ("192.168.1.100", "10.0.0.5", "172.16.3.9", "127.0.0.1"):
            self.assertIsNone(self.mod._validate_outbound_host(ip), ip)

    def test_public_ip_rejected(self):
        self.assertIsNotNone(self.mod._validate_outbound_host("8.8.8.8"))

    def test_arbitrary_hostname_rejected(self):
        self.assertIsNotNone(self.mod._validate_outbound_host("attacker.example.com"))

    def test_empty_rejected(self):
        self.assertIsNotNone(self.mod._validate_outbound_host(""))

    def test_credential_endpoint_refuses_public_host(self):
        result = self.mod._setup_proxmox_user("attacker.example.com", "root@pam", "secret")
        self.assertFalse(result.get("ok"))
        self.assertIn("host", result.get("error", "").lower())

    def test_discover_refuses_public_host(self):
        result = self.mod._discover_proxmox("evil.example.com", "infraweaver@pve!t=uuid")
        self.assertFalse(result.get("ok"))


class EnvNameSanitizeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_server_module("init_server_envname_test")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("init_server_envname_test", None)

    def test_valid_names_pass_through(self):
        self.assertEqual(self.mod._safe_env_name("productie"), "productie")
        self.assertEqual(self.mod._safe_env_name("staging-2"), "staging-2")

    def test_traversal_falls_back_to_default(self):
        self.assertEqual(self.mod._safe_env_name("../../../etc"), "productie")
        self.assertEqual(self.mod._safe_env_name("a/b"), "productie")
        self.assertEqual(self.mod._safe_env_name(""), "productie")
        self.assertEqual(self.mod._safe_env_name(None), "productie")


if __name__ == "__main__":
    unittest.main(verbosity=2)
