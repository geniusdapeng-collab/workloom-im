#!/usr/bin/env python3
"""Free isolated regressions: real Git repositories, no hosted writes or paid APIs."""
from contextlib import redirect_stdout, redirect_stderr
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("workloom_context", Path(__file__).with_name("workloom-context.py"))
wc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wc)


def run_git(repo, *args):
    result = subprocess.run(["git", *args], cwd=repo, env=wc.git_env(), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return result.stdout.strip()


def document():
    entries = []
    for name, lane, receive in (("workloom-im", "base", "none"), ("workloom-hotel", "industry", "subscribed"),
                                ("workloom-growthtest", "isolated", "none"), ("geo-evidence-studio", "config-only-discovered", "none")):
        entries.append({"logicalId": name, "productId": name, "lane": lane,
                        "github": {"repository": "geniusdapeng-collab/" + name, "url": "https://github.com/geniusdapeng-collab/" + name, "branch": "main"},
                        "cnb": None if name == "geo-evidence-studio" else {"repository": "workloom-ai/" + name, "url": "https://cnb.cool/workloom-ai/" + name, "branch": "main"},
                        "baseSync": {"receive": receive, "reflux": "proposal-only" if lane in ("base", "industry") else "none"}})
    return {"schemaVersion": "workloom.repository-registry/v1", "primaryPlatform": "github", "baseLogicalId": "workloom-im",
            "mirrorPolicy": {"platform": "cnb", "mode": "deferred", "automaticProductSync": False}, "repositories": entries}


class LocalGit(wc.Git):
    """Substitute the transport only; every git command still runs against real repositories."""
    def __init__(self, urls):
        self.urls = urls
        self.network_calls = []

    def run(self, directory, args, network=False, allowed=(0,)):
        if not network:
            return super().run(directory, args, network=False, allowed=allowed)
        original = list(args)
        urls = [value for value in args if value.startswith("https://")]
        if len(urls) != 1 or urls[0] not in self.urls:
            raise AssertionError("Unexpected external transport: " + repr(args))
        self.network_calls.append(urls[0])
        replaced = [str(self.urls[value]) if value in self.urls else value for value in args]
        result = super().run(directory, replaced, network=False, allowed=allowed)
        if original[0] == "clone":
            super().run(Path(original[-1]), ["remote", "set-url", "origin", urls[0]])
        return result


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="workloom-local-context-test-")
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache with spaces"
        self.env = patch.dict(os.environ, {"WORKLOOM_CONTEXT_DIR": str(self.cache), "WORKLOOM_BASE_SLUG": wc.DEFAULT_BASE,
                                          "GH_TOKEN": "", "GITHUB_TOKEN": ""})
        self.env.start()
        self.source = self.root / "source"
        self.source.mkdir()
        run_git(self.source, "init", "--quiet", "--initial-branch=main")
        run_git(self.source, "config", "user.name", "Fixture")
        run_git(self.source, "config", "user.email", "fixture@example.invalid")
        (self.source / "docs").mkdir()
        (self.source / "sync").mkdir()
        (self.source / "WORKLOOM_PRODUCT_CONTEXT.md").write_text("Verified fixture context\n")
        (self.source / "docs/DEVELOPMENT-PROTOCOL.md").write_text("Verified fixture protocol\n")
        (self.source / "sync/repository-registry.json").write_text(json.dumps(document()))
        (self.source / "sync/fanout-github.mjs").write_text("/* Isolated CLI transport fixture; no hosted operations. */\n")
        self.commit("initial")
        self.urls = {entry["github"]["url"] + ".git": self.source for entry in document()["repositories"]}
        self.git = LocalGit(self.urls)

    def tearDown(self):
        self.env.stop()
        self.temporary.cleanup()

    def commit(self, message):
        run_git(self.source, "add", "--all")
        run_git(self.source, "commit", "--quiet", "-m", message)
        return run_git(self.source, "rev-parse", "HEAD")

    def invoke(self, *args, git=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            result = wc.main(list(args), git=git or self.git)
        return result, out.getvalue(), err.getvalue()

    def install_cache(self):
        result, _, err = self.invoke("context")
        self.assertEqual(result, 0, err)

    def clone(self, name="workloom-im", origin=None):
        repo = self.root / ("local-" + name)
        self.git.run(None, ["clone", "--quiet", "--branch", "main", "https://github.com/geniusdapeng-collab/" + name + ".git", str(repo)], network=True)
        run_git(repo, "config", "user.name", "Fixture")
        run_git(repo, "config", "user.email", "fixture@example.invalid")
        if origin:
            run_git(repo, "remote", "set-url", "origin", origin)
        return repo

    def cache_state(self):
        return {str(path.relative_to(self.cache)): (path.lstat().st_mtime_ns, path.read_bytes())
                for path in self.cache.rglob("*") if path.is_file()}

    def test_registry_preserves_isolation_null_mapping_and_exact_targets(self):
        doc = wc.registry(document())
        self.assertEqual(len(wc.targets(doc, "repository-config", None)), 4)
        self.assertEqual([entry["logicalId"] for entry in wc.targets(doc, "full", None)], ["workloom-hotel"])
        with self.assertRaises(wc.Failure):
            wc.targets(doc, "required-only", "workloom-growthtest")
        self.assertIsNone(doc["repositories"][-1]["cnb"])

    def test_registry_rejects_cnb_primary_automatic_mirror_and_isolation_breach(self):
        for mutate in (lambda d: d.update(primaryPlatform="cnb"),
                       lambda d: d["mirrorPolicy"].update(automaticProductSync=True),
                       lambda d: d["repositories"][2]["baseSync"].update(receive="subscribed"),
                       lambda d: d["repositories"][2]["baseSync"].update(reflux="proposal-only")):
            doc = document()
            mutate(doc)
            with self.assertRaises(wc.Failure):
                wc.registry(doc)

    def test_remotes_accept_supported_forms_and_reject_credentials_unknown_hosts(self):
        expected = ("github.com", "geniusdapeng-collab/workloom-im")
        for value in ("https://github.com/geniusdapeng-collab/workloom-im.git", "git@github.com:geniusdapeng-collab/workloom-im.git", "ssh://git@github.com/geniusdapeng-collab/workloom-im"):
            self.assertEqual(wc.remote_identity(value), expected)
        for value in ("https://person:fixture@github.com/o/r", "https://person@github.com/o/r", "https://example.invalid/o/r", "https://github.com/o/r?token=fixture", "https://github.com/o/r\n"):
            with self.assertRaises(wc.Failure):
                wc.remote_identity(value)

    def test_current_token_stays_in_process_env_and_clears_inherited_git_state(self):
        secret = "test-only-current-operation-value"
        with patch.dict(os.environ, {"GH_TOKEN": secret, "GIT_DIR": "/invalid", "GIT_TRACE": "/invalid", "GIT_CONFIG_COUNT": "500"}):
            env = wc.git_env(True)
            self.assertNotIn("GIT_DIR", env)
            self.assertNotIn("GIT_TRACE", env)
            self.assertEqual(env["GIT_CONFIG_GLOBAL"], os.devnull)
            result = subprocess.run(["git", "config", "--get-all", "credential.helper"], env=env, text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.strip(), "")
            self.assertNotIn(secret, wc.redact(secret))
            encoded = wc.base64.b64encode(("x-access-token:" + secret).encode()).decode()
            self.assertNotIn(encoded, wc.redact(encoded))

    def test_auth_failure_never_invokes_global_helper_or_askpass(self):
        sentinel = self.root / "credential-helper-invoked"
        global_config = self.root / "global.gitconfig"
        global_config.write_text('[credential]\n helper = !touch "' + str(sentinel) + '"\n')
        class Deny(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="isolated-fixture"')
                self.end_headers()
            def log_message(self, *_):
                return
        server = HTTPServer(("127.0.0.1", 0), Deny)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(global_config), "GIT_ASKPASS": str(sentinel)}):
                with self.assertRaises(wc.Failure):
                    wc.Git().run(None, ["ls-remote", f"http://127.0.0.1:{server.server_port}/repo.git"], network=True)
            self.assertFalse(sentinel.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_repository_local_url_rewrite_is_rejected_before_network(self):
        run_git(self.source, "config", "url.https://example.invalid/.insteadOf", "https://github.com/")
        with self.assertRaisesRegex(wc.Failure, "URL rewrites"):
            wc.Git().run(self.source, ["fetch", "https://github.com/geniusdapeng-collab/workloom-im.git"], network=True)

    def test_clone_uses_isolated_cwd_instead_of_callers_repository_config(self):
        real_run = subprocess.run
        observed = []
        destination = self.root / "isolated-clone"
        def process(command, **kwargs):
            if command[:2] == ["git", "clone"]:
                observed.append(Path(kwargs["cwd"]))
                rewritten = [str(self.source) if value == "https://github.com/geniusdapeng-collab/workloom-im.git" else value for value in command]
                return real_run(rewritten, **kwargs)
            return real_run(command, **kwargs)
        with patch.object(wc.subprocess, "run", side_effect=process):
            wc.Git().run(None, ["clone", "--quiet", "https://github.com/geniusdapeng-collab/workloom-im.git", str(destination)], network=True)
        self.assertEqual(len(observed), 1)
        self.assertNotEqual(observed[0], Path.cwd())
        self.assertFalse(observed[0].exists())
        self.assertEqual(run_git(destination, "rev-parse", "HEAD"), run_git(self.source, "rev-parse", "HEAD"))

    def test_context_sync_pins_sha_hashes_and_check_is_readonly(self):
        self.install_cache()
        doc, meta = wc.cached_registry(self.cache)
        self.assertEqual(meta["base_main_sha"], run_git(self.source, "rev-parse", "HEAD"))
        self.assertEqual(doc["primaryPlatform"], "github")
        self.assertTrue((self.cache / "current").is_symlink())
        for name in wc.FILES:
            self.assertEqual(os.readlink(self.cache / name), "current/" + name)
            self.assertEqual(meta["sha256"][name], hashlib.sha256((self.cache / name).read_bytes()).hexdigest())
        before = self.cache_state()
        self.assertEqual(self.invoke("context", "--check")[0], 0)
        self.assertEqual(before, self.cache_state())

    def test_check_missing_cache_returns_stale_without_creating_it(self):
        self.assertEqual(self.invoke("context", "--check")[0], 3)
        self.assertFalse(self.cache.exists())

    def test_missing_registry_on_actual_main_preserves_previous_cache(self):
        self.install_cache()
        before = self.cache_state()
        (self.source / "sync/repository-registry.json").unlink()
        self.commit("registry missing")
        self.assertEqual(self.invoke("context")[0], 4)
        self.assertEqual(before, self.cache_state())

    def test_cache_update_switches_generation_and_keeps_prior_bytes(self):
        self.install_cache()
        old = (self.cache / "current").resolve()
        old_body = (old / "WORKLOOM_PRODUCT_CONTEXT.md").read_bytes()
        (self.source / "WORKLOOM_PRODUCT_CONTEXT.md").write_text("New main context\n")
        sha = self.commit("context update")
        self.assertEqual(self.invoke("context", "--check")[0], 3)
        self.install_cache()
        self.assertNotEqual((self.cache / "current").resolve(), old)
        self.assertEqual((old / "WORKLOOM_PRODUCT_CONTEXT.md").read_bytes(), old_body)
        self.assertEqual(wc.cached_registry(self.cache)[1]["base_main_sha"], sha)

    def test_legacy_migration_rolls_back_on_replace_failure(self):
        self.cache.mkdir()
        original = {name: ("legacy-" + name).encode() for name in (*wc.FILES, "meta.json")}
        for name, body in original.items():
            (self.cache / name).write_bytes(body)
        real_replace = os.replace
        def fail_link(source, target):
            if Path(target).name == "DEVELOPMENT-PROTOCOL.md":
                raise OSError("isolated replacement failure")
            return real_replace(source, target)
        with patch.object(wc.os, "replace", side_effect=fail_link):
            self.assertEqual(self.invoke("context")[0], 4)
        self.assertFalse((self.cache / "current").is_symlink())
        self.assertEqual({name: (self.cache / name).read_bytes() for name in original}, original)

    def test_tampered_cache_is_rejected_for_dryrun(self):
        self.install_cache()
        (self.cache / "WORKLOOM_PRODUCT_CONTEXT.md").write_text("tampered\n")
        self.assertEqual(self.invoke("cloud", "--dry-run")[0], 4)

    def test_malformed_cache_metadata_fails_without_traceback_or_network(self):
        self.install_cache()
        before = len(self.git.network_calls)
        (self.cache / "meta.json").write_text("[]\n")
        result, _, err = self.invoke("cloud", "--dry-run")
        self.assertEqual(result, 4)
        self.assertNotIn("Traceback", err)
        self.assertEqual(len(self.git.network_calls), before)

    def test_symlinked_source_directory_cannot_replace_controlled_cache(self):
        self.install_cache()
        before = self.cache_state()
        outside = self.root / "outside-documents"
        outside.mkdir()
        (outside / "DEVELOPMENT-PROTOCOL.md").write_text("outside fixture must not become controlled data\n")
        shutil.rmtree(self.source / "docs")
        (self.source / "docs").symlink_to(outside)
        self.commit("symlinked source directory")
        self.assertEqual(self.invoke("context")[0], 4)
        self.assertEqual(before, self.cache_state())

    def test_candidate_source_head_cannot_enter_cache(self):
        repo = self.clone()
        (repo / "candidate-only.txt").write_text("candidate\n")
        run_git(repo, "add", "--all")
        run_git(repo, "commit", "--quiet", "-m", "local candidate")
        with self.assertRaisesRegex(wc.Failure, "candidate"):
            wc.source_snapshot(repo, self.git)

    def test_fleet_migrates_correct_cnb_origin_and_only_fastforwards_github(self):
        entry = document()["repositories"][0]
        repo = self.clone(origin=entry["cnb"]["url"] + ".git")
        fleet = self.root / "fleet"
        fleet.mkdir()
        repo.rename(fleet / "workloom-im")
        (self.source / "new-main.txt").write_text("new main\n")
        sha = self.commit("new main")
        state, repo = wc.synchronize_one(fleet, entry, self.git)
        self.assertEqual(state, "updated")
        self.assertEqual(run_git(repo, "rev-parse", "HEAD"), sha)
        self.assertEqual(run_git(repo, "remote", "get-url", "origin"), entry["github"]["url"] + ".git")
        self.assertEqual(run_git(repo, "remote", "get-url", "cnb"), entry["cnb"]["url"] + ".git")
        self.assertTrue(all(url.startswith("https://github.com/") for url in self.git.network_calls))

    def test_fleet_dirty_or_task_branch_skips_without_network_or_origin_change(self):
        entry = document()["repositories"][0]
        fleet = self.root / "fleet"
        fleet.mkdir()
        repo = self.clone(origin=entry["cnb"]["url"] + ".git")
        repo.rename(fleet / "workloom-im")
        repo = fleet / "workloom-im"
        before_calls = len(self.git.network_calls)
        (repo / "WORKLOOM_PRODUCT_CONTEXT.md").write_text("local pending edits\n")
        self.assertEqual(wc.synchronize_one(fleet, entry, self.git)[0], "skipped-dirty")
        run_git(repo, "restore", "WORKLOOM_PRODUCT_CONTEXT.md")
        run_git(repo, "checkout", "--quiet", "-b", "task/in-use")
        self.assertEqual(wc.synchronize_one(fleet, entry, self.git)[0], "skipped-branch")
        self.assertEqual(len(self.git.network_calls), before_calls)
        self.assertEqual(run_git(repo, "remote", "get-url", "origin"), entry["cnb"]["url"] + ".git")

    def test_fleet_wrong_origin_is_rejected_without_fetch(self):
        entry = document()["repositories"][0]
        fleet = self.root / "fleet"
        fleet.mkdir()
        self.clone(origin="https://github.com/unregistered/wrong.git").rename(fleet / "workloom-im")
        before = len(self.git.network_calls)
        with self.assertRaises(wc.Failure):
            wc.synchronize_one(fleet, entry, self.git)
        self.assertEqual(len(self.git.network_calls), before)

    def test_fleet_local_main_ahead_is_preserved_and_rejected(self):
        entry = document()["repositories"][0]
        fleet = self.root / "fleet"
        fleet.mkdir()
        repo = self.clone()
        repo.rename(fleet / "workloom-im")
        repo = fleet / "workloom-im"
        (repo / "local-main.txt").write_text("must survive\n")
        run_git(repo, "add", "--all")
        run_git(repo, "commit", "--quiet", "-m", "local ahead")
        sha = run_git(repo, "rev-parse", "HEAD")
        with self.assertRaisesRegex(wc.Failure, "ahead"):
            wc.synchronize_one(fleet, entry, self.git)
        self.assertEqual(run_git(repo, "rev-parse", "HEAD"), sha)
        self.assertEqual((repo / "local-main.txt").read_text(), "must survive\n")

    def test_fleet_updates_own_isolated_mirror_without_product_fanout(self):
        result, out, err = self.invoke("fleet", "--fleet-dir", str(self.root / "fleet"), "--quiet")
        self.assertEqual(result, 0, err)
        summary = json.loads(out)
        self.assertEqual(summary["updated"], 4)
        isolated = self.root / "fleet/workloom-growthtest"
        self.assertTrue((isolated / ".git").exists())
        self.assertEqual(run_git(isolated, "rev-parse", "HEAD"), run_git(self.source, "rev-parse", "HEAD"))
        self.assertEqual(wc.cached_registry(self.cache)[0]["repositories"][2]["baseSync"]["receive"], "none")

    def test_freshness_uses_github_for_cnb_origin_and_detects_new_main(self):
        self.install_cache()
        origin = "https://cnb.cool/workloom-ai/workloom-im.git"
        repo = self.clone(origin=origin)
        self.assertEqual(self.invoke("freshness", str(repo))[0], 0)
        (self.source / "new-main.txt").write_text("new main\n")
        self.commit("new main")
        result, out, _ = self.invoke("freshness", str(repo))
        self.assertEqual(result, 3)
        self.assertIn("github_main=", out)
        self.assertEqual(run_git(repo, "remote", "get-url", "origin"), origin)

    def test_freshness_unknown_origin_or_unrelated_history_returns_unknown(self):
        self.install_cache()
        repo = self.clone(origin="https://github.com/unregistered/wrong.git")
        self.assertEqual(self.invoke("freshness", str(repo))[0], 4)
        run_git(repo, "remote", "set-url", "origin", "https://github.com/geniusdapeng-collab/workloom-im.git")
        run_git(repo, "checkout", "--quiet", "--orphan", "unrelated")
        run_git(repo, "add", "--all")
        run_git(repo, "commit", "--quiet", "-m", "unrelated")
        self.assertEqual(self.invoke("freshness", str(repo))[0], 4)

    def test_cloud_dryrun_needs_no_token_and_performs_zero_network(self):
        self.install_cache()
        before = len(self.git.network_calls)
        result, out, err = self.invoke("cloud", "--dry-run")
        self.assertEqual(result, 0, err)
        plan = json.loads(out)
        self.assertEqual(plan["mode"], "repository-config")
        self.assertEqual(plan["networkRequests"], 0)
        self.assertEqual(len(plan["targets"]), 4)
        self.assertEqual(len(self.git.network_calls), before)
        self.assertEqual(self.invoke("cloud", "--mode", "full", "--only", "workloom-growthtest", "--dry-run")[0], 4)

    def test_cnb_deferred_missing_token_and_nonmain_never_start_network(self):
        result, out, _ = self.invoke("cloud", "--platform", "cnb")
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(out)["pipelinesTriggered"], 0)
        self.assertEqual(self.invoke("cloud")[0], 4)
        self.assertEqual(self.invoke("cloud", "--branch", "candidate")[0], 4)
        self.assertEqual(self.git.network_calls, [])

    def test_cloud_actual_binds_current_main_receipt_without_token_in_argv(self):
        sha = run_git(self.source, "rev-parse", "HEAD")
        real_run = subprocess.run
        received = []
        secret = "test-only-current-operation-value"
        def process(command, **kwargs):
            if command[0] == "/fixture/node":
                received.append((command, kwargs["env"]))
                return subprocess.CompletedProcess(command, 0, json.dumps({"baseSha": sha, "deliveryComplete": True, "results": []}), "")
            return real_run(command, **kwargs)
        with patch.dict(os.environ, {"GH_TOKEN": secret, "WORKLOOM_NODE_BIN": "/fixture/node"}), patch.object(wc.subprocess, "run", side_effect=process):
            result, out, err = self.invoke("cloud", "--only", "workloom-hotel")
        self.assertEqual(result, 0, err)
        self.assertFalse(json.loads(out)["deliveryComplete"])
        self.assertEqual(len(received), 1)
        self.assertNotIn(secret, repr(received[0][0]))
        self.assertEqual(received[0][1]["GH_TOKEN"], secret)
        self.assertIn("--only", received[0][0])

    def test_cloud_mismatched_receipt_fails_closed(self):
        real_run = subprocess.run
        def process(command, **kwargs):
            if command[0] == "/fixture/node":
                return subprocess.CompletedProcess(command, 0, json.dumps({"baseSha": "0" * 40}), "")
            return real_run(command, **kwargs)
        with patch.dict(os.environ, {"GH_TOKEN": "test-only-value", "WORKLOOM_NODE_BIN": "/fixture/node"}), patch.object(wc.subprocess, "run", side_effect=process):
            self.assertEqual(self.invoke("cloud")[0], 4)

    def test_wrappers_resolve_helper_in_directory_with_spaces(self):
        folder = self.root / "installed skill with spaces/scripts"
        folder.mkdir(parents=True)
        source = Path(__file__).parent
        for name in ("sync-context.sh", "sync-fleet-local.sh", "check-worktree-freshness.sh", "fleet-cloud-sync.sh", "workloom-context.py"):
            shutil.copy2(source / name, folder / name)
        for name in ("sync-context.sh", "sync-fleet-local.sh", "check-worktree-freshness.sh", "fleet-cloud-sync.sh"):
            result = subprocess.run(["sh", str(folder / name), "--help"], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
