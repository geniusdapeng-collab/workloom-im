#!/usr/bin/env python3
"""GitHub-primary local context, fleet mirrors, freshness and candidate fanout.

Only Python's standard library and the existing git/node executables are used.
CNB is an address mapping and deferred mirror, never a pipeline fallback.
"""
import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import urlsplit

DEFAULT_BASE = "geniusdapeng-collab/workloom-im"
SLUG = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SHA = re.compile(r"[a-f0-9]{40,64}\Z")
FILES = {
    "WORKLOOM_PRODUCT_CONTEXT.md": "WORKLOOM_PRODUCT_CONTEXT.md",
    "DEVELOPMENT-PROTOCOL.md": "docs/DEVELOPMENT-PROTOCOL.md",
    "repository-registry.json": "sync/repository-registry.json",
}
MAIN_REF = "refs/remotes/workloom-github/main"


class Failure(Exception):
    pass


def base_slug():
    value = os.environ.get("WORKLOOM_BASE_SLUG", DEFAULT_BASE)
    if not SLUG.fullmatch(value):
        raise Failure("WORKLOOM_BASE_SLUG must be a credential-free GitHub owner/repository")
    return value


def token():
    return os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""


def redact(value):
    text = str(value)
    secret = token()
    if secret:
        for raw in (secret, base64.b64encode(("x-access-token:" + secret).encode()).decode()):
            text = text.replace(raw, "[REDACTED]")
    text = re.sub(r"(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}", "[REDACTED]", text)
    return re.sub(r"(https?://)[^/@\s]+@", r"\1[REDACTED]@", text)


def git_env(network=False):
    # Do not inherit a caller's GIT_DIR, injected config, trace file or askpass.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_SYSTEM=os.devnull,
               GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0",
               GIT_ASKPASS="/usr/bin/false", SSH_ASKPASS="/usr/bin/false")
    settings = [("credential.helper", ""), ("credential.https://github.com.helper", ""),
                ("core.askPass", "/usr/bin/false"), ("core.hooksPath", os.devnull),
                ("http.extraHeader", ""), ("http.https://github.com/.extraHeader", ""),
                ("http.followRedirects", "false")]
    if network and token():
        auth = base64.b64encode(("x-access-token:" + token()).encode()).decode()
        settings.append(("http.https://github.com/.extraHeader", "AUTHORIZATION: basic " + auth))
    env["GIT_CONFIG_COUNT"] = str(len(settings))
    for index, (key, value) in enumerate(settings):
        env[f"GIT_CONFIG_KEY_{index}"] = key
        env[f"GIT_CONFIG_VALUE_{index}"] = value
    return env


class Git:
    def run(self, directory, args, network=False, allowed=(0,)):
        if directory is None:
            # Even a clone started inside another worktree must not inherit its local URL rules.
            with tempfile.TemporaryDirectory(prefix="workloom-git-cwd-") as temporary:
                return self.run(Path(temporary), args, network=network, allowed=allowed)
        if network and directory is not None:
            # A repository-local URL rewrite could send an explicit HTTPS fetch elsewhere.
            config = self.run(directory, ["config", "--local", "--includes", "--get-regexp", r"^url\..*\.insteadof$"], allowed=(0, 1, 128))
            if config:
                raise Failure("Repository-local URL rewrites are not allowed for GitHub network operations")
        try:
            result = subprocess.run(["git", *args], cwd=directory, env=git_env(network),
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=120, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Failure("Git operation failed: " + redact(type(error).__name__)) from error
        if result.returncode not in allowed:
            raise Failure(f"Git operation failed ({result.returncode}): " + redact(result.stderr.strip())[:1200])
        return result.stdout.rstrip("\n")


def remote_identity(remote):
    if not isinstance(remote, str) or re.search(r"[\x00\r\n]", remote):
        raise Failure("Invalid repository remote")
    match = re.fullmatch(r"git@(github\.com|cnb\.cool):(.+)", remote)
    if match:
        host, slug = match.groups()
    else:
        url = urlsplit(remote)
        if url.scheme not in ("https", "ssh") or url.hostname not in ("github.com", "cnb.cool"):
            raise Failure("Repository origin must use a registered GitHub or CNB address")
        if url.password or url.query or url.fragment or (url.username and not (url.scheme == "ssh" and url.username == "git")):
            raise Failure("Repository remote must not contain credentials or URL parameters")
        try:
            if url.port is not None and not (url.scheme == "ssh" and url.port == 22):
                raise Failure("Unexpected repository remote port")
        except ValueError as error:
            raise Failure("Invalid repository remote port") from error
        host, slug = url.hostname, url.path.lstrip("/")
    if slug.endswith(".git"):
        slug = slug[:-4]
    if not SLUG.fullmatch(slug):
        raise Failure("Invalid repository path")
    return host, slug.lower()


def registry(document):
    if not isinstance(document, dict):
        raise Failure("Repository registry must be an object")
    if document.get("schemaVersion") != "workloom.repository-registry/v1" or document.get("primaryPlatform") != "github":
        raise Failure("A GitHub-primary repository registry is required; the previous cache is preserved")
    mirror = document.get("mirrorPolicy", {})
    if not isinstance(mirror, dict):
        raise Failure("Invalid mirror policy")
    if (mirror.get("platform"), mirror.get("mode"), mirror.get("automaticProductSync")) != ("cnb", "deferred", False):
        raise Failure("CNB must remain a deferred mirror with product sync disabled")
    entries = document.get("repositories")
    if not isinstance(entries, list) or not entries:
        raise Failure("Repository registry is empty")
    ids, addresses = set(), set()
    lanes = {"base", "industry", "operations-hub", "experiment", "isolated", "config-only-discovered"}
    for entry in entries:
        if not isinstance(entry, dict):
            raise Failure("Invalid registry entry")
        identity = entry.get("logicalId", "")
        if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", identity) or identity in ids or entry.get("lane") not in lanes:
            raise Failure("Invalid or duplicate registry identity")
        ids.add(identity)
        for platform, host in (("github", "github.com"), ("cnb", "cnb.cool")):
            address = entry.get(platform)
            if platform == "cnb" and address is None:
                continue
            if not isinstance(address, dict) or not SLUG.fullmatch(address.get("repository", "")):
                raise Failure("Invalid registry repository address")
            if address.get("url") != f"https://{host}/{address['repository']}" or address.get("branch") != "main":
                raise Failure("Registry addresses must be credential-free canonical main branches")
            url = address["url"].lower()
            if url in addresses:
                raise Failure("Duplicate registry repository address")
            addresses.add(url)
        policy = entry.get("baseSync", {})
        if not isinstance(policy, dict):
            raise Failure("Invalid base sync policy")
        if policy.get("receive") not in ("none", "subscribed"):
            raise Failure("Invalid base sync policy")
        if entry["lane"] in ("isolated", "config-only-discovered") and policy["receive"] != "none":
            raise Failure("Isolated and discovered repositories cannot receive product fanout")
        if entry["lane"] in ("experiment", "isolated", "config-only-discovered") and policy.get("reflux") != "none":
            raise Failure("Experimental and isolated semantics cannot flow back to the base")
    base = next((entry for entry in entries if entry["logicalId"] == document.get("baseLogicalId")), None)
    if base is None or base["lane"] != "base" or base["github"]["repository"] != base_slug():
        raise Failure("Registry base identity does not match the configured GitHub base")
    return document


def read_regular(path):
    if path.is_symlink() or not path.is_file():
        raise Failure("Controlled source document is missing or is a symlink: " + path.name)
    return path.read_bytes()


def source_snapshot(repo, git):
    head = git.run(repo, ["rev-parse", "HEAD"])
    if not SHA.fullmatch(head):
        raise Failure("Invalid GitHub main commit")
    main = git.run(repo, ["rev-parse", "--verify", MAIN_REF], allowed=(0, 128))
    if not main:
        main = git.run(repo, ["rev-parse", "refs/remotes/origin/main"])
    if head != main:
        raise Failure("Local source HEAD differs from fetched GitHub main; candidate bytes cannot enter the cache")
    for relative in FILES.values():
        if any((repo / parent).is_symlink() for parent in Path(relative).parents if parent != Path(".")):
            raise Failure("Controlled source directory must not be a symlink")
    bodies = {name: read_regular(repo / path) for name, path in FILES.items()}
    registry(json.loads(bodies["repository-registry.json"]))
    meta = {"source": f"https://github.com/{base_slug()}", "branch": "main", "base_main_sha": head,
            "synced_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "sha256": {name: hashlib.sha256(body).hexdigest() for name, body in bodies.items()},
            "note": "Controlled GitHub main snapshot; candidate branches are not cache sources."}
    bodies["meta.json"] = (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode()
    return bodies, meta


def clone_base(temporary, git):
    repo = Path(temporary) / "base"
    git.run(None, ["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", "main",
                   f"https://github.com/{base_slug()}.git", str(repo)], network=True)
    return repo


def cache_directory():
    return Path(os.environ.get("WORKLOOM_CONTEXT_DIR", str(Path.home() / ".codex/workloom-context"))).expanduser()


def install_snapshot(cache, bodies):
    cache.mkdir(parents=True, exist_ok=True)
    lock = cache / ".sync.lock"
    if lock.is_symlink():
        raise Failure("Cache lock must not be a symlink")
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        _install_snapshot(cache, bodies)


def _install_snapshot(cache, bodies):
    # All later updates switch a single pointer; the legacy top-level paths stay stable.
    cache.mkdir(parents=True, exist_ok=True)
    versions = cache / ".generations"
    if versions.is_symlink():
        raise Failure("Cache generation directory must not be a symlink")
    versions.mkdir(exist_ok=True)
    generation = versions / uuid.uuid4().hex
    generation.mkdir()
    previous = {}
    for name in bodies:
        path = cache / name
        if path.is_symlink():
            if os.readlink(path) != f"current/{name}":
                raise Failure("Unexpected controlled cache symlink: " + name)
            previous[name] = ("symlink", os.readlink(path))
        elif path.exists():
            previous[name] = ("file", read_regular(path))
        else:
            previous[name] = None
    current = cache / "current"
    if current.exists() and not current.is_symlink():
        raise Failure("Cache current pointer must be a symlink")
    previous_pointer = os.readlink(current) if current.is_symlink() else None
    if previous_pointer is not None and not re.fullmatch(r"\.generations/[a-f0-9]{32}", previous_pointer):
        raise Failure("Unexpected cache generation pointer")
    pending = cache / (".current-" + uuid.uuid4().hex)
    try:
        for name, body in bodies.items():
            (generation / name).write_bytes(body)
        pending.symlink_to(str(generation.relative_to(cache)))
        os.replace(pending, current)
        for name in bodies:
            path = cache / name
            if path.is_symlink():
                continue
            link = cache / (".link-" + uuid.uuid4().hex)
            link.symlink_to(f"current/{name}")
            os.replace(link, path)
    except BaseException:
        # Preserve the last usable cache if the one-time legacy path migration fails.
        for name, old in previous.items():
            path = cache / name
            if path.is_symlink() or path.exists():
                path.unlink()
            if old and old[0] == "symlink":
                path.symlink_to(old[1])
            elif old:
                path.write_bytes(old[1])
        if current.is_symlink():
            current.unlink()
        if previous_pointer is not None:
            current.symlink_to(previous_pointer)
        raise
    finally:
        if pending.is_symlink():
            pending.unlink()


def cache_matches(cache, bodies, meta):
    try:
        local = json.loads((cache / "meta.json").read_text())
        return (isinstance(local, dict) and local.get("source") == meta["source"] and local.get("branch") == "main"
                and local.get("base_main_sha") == meta["base_main_sha"]
                and local.get("sha256") == meta["sha256"]
                and all((cache / name).read_bytes() == bodies[name] for name in FILES))
    except (OSError, ValueError):
        return False


def cached_registry(cache):
    try:
        meta = json.loads((cache / "meta.json").read_text())
        if not isinstance(meta, dict) or meta.get("source") != f"https://github.com/{base_slug()}" or meta.get("branch") != "main" or not SHA.fullmatch(meta.get("base_main_sha", "")):
            raise Failure("Cache is not a verified GitHub main snapshot; run sync-context.sh first")
        hashes = meta.get("sha256")
        if not isinstance(hashes, dict):
            raise Failure("Controlled cache digests are missing; run sync-context.sh first")
        for name in FILES:
            if hashlib.sha256((cache / name).read_bytes()).hexdigest() != hashes.get(name):
                raise Failure("Controlled cache digest mismatch; run sync-context.sh first")
        return registry(json.loads((cache / "repository-registry.json").read_text())), meta
    except (OSError, ValueError) as error:
        raise Failure("No valid GitHub context cache; run sync-context.sh first") from error


def sync_context(args, git):
    with tempfile.TemporaryDirectory(prefix="workloom-context-") as temporary:
        repo = clone_base(temporary, git)
        bodies, meta = source_snapshot(repo, git)
        cache = cache_directory()
        if args.check:
            fresh = cache_matches(cache, bodies, meta)
            print(("UP-TO-DATE" if fresh else "STALE") + f" github_main={meta['base_main_sha']}")
            return 0 if fresh else 3
        install_snapshot(cache, bodies)
        print(f"SYNCED github_main={meta['base_main_sha']} registry={meta['sha256']['repository-registry.json']}")
        return 0


def origin_entry(repo, document, git):
    values = git.run(repo, ["remote", "get-url", "--all", "origin"]).splitlines()
    if len(values) != 1:
        raise Failure("Exactly one credential-free origin is required")
    identity = remote_identity(values[0])
    for entry in document["repositories"]:
        for platform in ("github", "cnb"):
            address = entry.get(platform)
            if address and remote_identity(address["url"]) == identity:
                return entry, platform
    raise Failure("Origin does not match any registered repository")


def fetch_main(repo, entry, git, unshallow=False):
    args = ["fetch", "--quiet", "--no-tags"]
    if unshallow:
        args.append("--unshallow")
    args.extend([entry["github"]["url"] + ".git", "+refs/heads/main:" + MAIN_REF])
    git.run(repo, args, network=True)


def synchronize_one(fleet, entry, git):
    repo = fleet / entry["github"]["repository"].split("/")[1]
    if not repo.exists():
        git.run(None, ["clone", "--quiet", "--single-branch", "--branch", "main", entry["github"]["url"] + ".git", str(repo)], network=True)
        git.run(repo, ["update-ref", MAIN_REF, git.run(repo, ["rev-parse", "HEAD"])])
        return "updated", repo
    if not (repo / ".git").exists():
        raise Failure("Fleet path exists without a Git worktree: " + repo.name)
    actual, platform = origin_entry(repo, {"repositories": [entry]}, git)
    if actual["logicalId"] != entry["logicalId"]:
        raise Failure("Fleet directory has the wrong repository identity")
    if git.run(repo, ["status", "--porcelain=v1", "--untracked-files=no"]):
        return "skipped-dirty", repo
    if git.run(repo, ["symbolic-ref", "--short", "-q", "HEAD"], allowed=(0, 1)) != "main":
        return "skipped-branch", repo
    if platform == "cnb":
        cnb = git.run(repo, ["remote", "get-url", "cnb"], allowed=(0, 2, 128))
        if cnb and remote_identity(cnb) != remote_identity(entry["cnb"]["url"]):
            raise Failure("Existing cnb remote has a different identity")
        if not cnb:
            git.run(repo, ["remote", "add", "cnb", entry["cnb"]["url"] + ".git"])
    git.run(repo, ["remote", "set-url", "origin", entry["github"]["url"] + ".git"])
    git.run(repo, ["config", "--local", "--unset-all", "remote.origin.pushurl"], allowed=(0, 5))
    git.run(repo, ["config", "--local", "remote.pushDefault", "origin"])
    git.run(repo, ["config", "--local", "branch.main.remote", "origin"])
    git.run(repo, ["config", "--local", "branch.main.merge", "refs/heads/main"])
    fetch_main(repo, entry, git)
    before = git.run(repo, ["rev-parse", "HEAD"])
    remote = git.run(repo, ["rev-parse", MAIN_REF])
    if before == remote:
        return "current", repo
    if git.run(repo, ["rev-parse", "--is-shallow-repository"]) == "true":
        fetch_main(repo, entry, git, unshallow=True)
        remote = git.run(repo, ["rev-parse", MAIN_REF])
    if git.run(repo, ["merge-base", "HEAD", MAIN_REF], allowed=(0, 1)) != before:
        raise Failure("Local main is ahead of or diverges from GitHub main; no worktree files were replaced")
    git.run(repo, ["merge", "--quiet", "--ff-only", MAIN_REF])
    if git.run(repo, ["rev-parse", "HEAD"]) != remote:
        raise Failure("Fast-forward result does not equal fetched GitHub main")
    return "updated", repo


def sync_fleet(args, git):
    fleet = Path(args.fleet_dir).expanduser()
    fleet.mkdir(parents=True, exist_ok=True)
    base = {"logicalId": "workloom-im", "github": {"repository": base_slug(), "url": f"https://github.com/{base_slug()}"},
            "cnb": {"url": "https://cnb.cool/workloom-ai/workloom-im"}}
    state, repo = synchronize_one(fleet, base, git)
    if state.startswith("skipped"):
        print(f"[skip] base {state}; the previous registry/cache is preserved", file=sys.stderr)
        return 3
    bodies, meta = source_snapshot(repo, git)
    doc = registry(json.loads(bodies["repository-registry.json"]))
    counts = {"updated": int(state == "updated"), "current": int(state == "current"), "skipped": 0, "failed": 0}
    for entry in doc["repositories"]:
        if entry["logicalId"] == doc["baseLogicalId"]:
            continue
        try:
            state, _ = synchronize_one(fleet, entry, git)
            counts["skipped" if state.startswith("skipped") else state] += 1
            if not args.quiet or state.startswith("skipped"):
                print(f"[{state}] {entry['logicalId']} lane={entry['lane']}")
        except Failure as error:
            counts["failed"] += 1
            print(f"[fail] {entry['logicalId']}: {redact(error)}", file=sys.stderr)
    install_snapshot(cache_directory(), bodies)
    print(json.dumps({"platform": "github", "baseMainSha": meta["base_main_sha"], "fleetDirectory": str(fleet), **counts}, ensure_ascii=False))
    return 4 if counts["failed"] else (3 if counts["skipped"] else 0)


def freshness(args, git):
    doc, _ = cached_registry(cache_directory())
    failed = stale = 0
    for value in args.repositories or ["."]:
        repo = Path(value).resolve()
        try:
            entry, _ = origin_entry(repo, doc, git)
            fetch_main(repo, entry, git)
            head = git.run(repo, ["rev-parse", "HEAD"])
            main = git.run(repo, ["rev-parse", MAIN_REF])
            common = git.run(repo, ["merge-base", "HEAD", MAIN_REF], allowed=(0, 1))
            if not common and git.run(repo, ["rev-parse", "--is-shallow-repository"]) == "true":
                fetch_main(repo, entry, git, unshallow=True)
                main = git.run(repo, ["rev-parse", MAIN_REF])
                common = git.run(repo, ["merge-base", "HEAD", MAIN_REF], allowed=(0, 1))
            if not common:
                raise Failure("No verifiable common ancestor with GitHub main")
            state = "fresh" if common == main else "stale"
            stale += int(state == "stale")
            print(f"[{state}] {entry['logicalId']} head={head} github_main={main}")
        except Failure as error:
            failed += 1
            print(f"[fail] {repo.name}: {redact(error)}", file=sys.stderr)
    return 4 if failed else (3 if stale else 0)


def targets(doc, mode, only):
    entries = doc["repositories"]
    if only:
        entries = [entry for entry in entries if only in (entry["logicalId"], entry["github"]["repository"], (entry.get("cnb") or {}).get("repository"))]
        if not entries:
            raise Failure("Requested repository is not registered")
    if mode != "repository-config":
        if only and entries[0]["baseSync"]["receive"] != "subscribed":
            raise Failure("Product fanout is forbidden for isolated or config-only repositories")
        entries = [entry for entry in entries if entry["baseSync"]["receive"] == "subscribed"
                   and (mode != "full" or only or entry["baseSync"].get("uiRolloutWave") != "paused")]
    return [{"logicalId": entry["logicalId"], "repository": entry["github"]["repository"], "lane": entry["lane"]} for entry in entries]


def cloud_sync(args, git):
    if args.platform == "cnb":
        print(json.dumps({"platform": "cnb", "state": "deferred", "remoteWrites": 0, "pipelinesTriggered": 0,
                          "note": "CNB mirror work is recorded separately; this entry point never triggers a CNB pipeline."}))
        return 0
    if args.branch != "main":
        raise Failure("Cloud fanout source must be actual GitHub main")
    if args.dry_run:
        doc, meta = cached_registry(cache_directory())
        print(json.dumps({"platform": "github", "mode": args.mode, "dryRun": True, "sourceBaseSha": meta["base_main_sha"],
                          "targets": targets(doc, args.mode, args.only), "networkRequests": 0, "remoteWrites": 0,
                          "note": "Plan uses the verified local cache; actual execution fetches current GitHub main."}, ensure_ascii=False, indent=2))
        return 0
    if not token():
        raise Failure("An explicit current-operation GH_TOKEN or GITHUB_TOKEN is required; no identity fallback is performed")
    node = os.environ.get("WORKLOOM_NODE_BIN") or shutil.which("node")
    if not node:
        raise Failure("Node executable is missing; set WORKLOOM_NODE_BIN to the existing runtime")
    with tempfile.TemporaryDirectory(prefix="workloom-fanout-") as temporary:
        repo = clone_base(temporary, git)
        _, meta = source_snapshot(repo, git)
        cli = repo / "sync/fanout-github.mjs"
        read_regular(cli)
        command = [node, str(cli), "--base-dir", str(repo), "--mode", args.mode]
        if args.only:
            command.extend(["--only", args.only])
        try:
            result = subprocess.run(command, cwd=repo, env=git_env(True), text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3600, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Failure("GitHub fanout failed: " + type(error).__name__) from error
        if result.returncode:
            raise Failure("GitHub fanout failed: " + redact(result.stderr)[:1600])
        output = json.loads(result.stdout)
        if not isinstance(output, dict) or output.get("baseSha") != meta["base_main_sha"]:
            raise Failure("Fanout receipt does not bind the fetched GitHub main SHA")
        output["deliveryComplete"] = False
        output["note"] = "Candidates require review, tests and verified main integration receipts; CNB is deferred."
        print(redact(json.dumps(output, ensure_ascii=False, indent=2)))
    return 0


def main(argv=None, git=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    context = commands.add_parser("context")
    context.add_argument("--check", action="store_true")
    fleet = commands.add_parser("fleet")
    fleet.add_argument("--quiet", action="store_true")
    fleet.add_argument("--fleet-dir", default=os.environ.get("WORKLOOM_FLEET_DIR", str(Path.home() / "WorkLoom-fleet")))
    fresh = commands.add_parser("freshness")
    fresh.add_argument("repositories", nargs="*")
    cloud = commands.add_parser("cloud")
    cloud.add_argument("--platform", choices=("github", "cnb"), default="github")
    cloud.add_argument("--mode", choices=("repository-config", "required-only", "full"), default="repository-config")
    cloud.add_argument("--only")
    cloud.add_argument("--branch", default="main")
    cloud.add_argument("--dry-run", action="store_true")
    cloud.add_argument("--no-wait", action="store_true", help="Compatibility flag; GitHub candidate creation is synchronous")
    cloud.add_argument("--json", action="store_true", help="Output is always structured JSON")
    args = parser.parse_args(argv)
    try:
        return {"context": sync_context, "fleet": sync_fleet, "freshness": freshness, "cloud": cloud_sync}[args.command](args, git or Git())
    except (Failure, OSError, ValueError, KeyError, TypeError) as error:
        print("[fail] " + redact(error), file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
