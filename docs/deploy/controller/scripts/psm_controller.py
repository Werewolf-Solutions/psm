#!/usr/bin/env python3
"""DRAFT of Werewolf-Solutions/deployment-control scripts/psm_controller.py.

The werewolf-static@1 release controller. Every value this acts on comes from a dispatch
input covered by execution_contract_digest, or from a file in this repository at the
pinned commit. It never evaluates project code and never writes a credential to disk in
a form that outlives the job.

Mirrors these PSM definitions exactly; changing either side without the other breaks the
release, which is the intended failure mode:
  canonical JSON / digest    src/server/deploy/canonical.ts
  execution contract         src/server/deploy/adapters/executor-contract.ts
  release result             parseStaticReleaseResult, same file
  host helper wire protocol  host-helper/protocol.go
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

CONTRACT_SCHEMA = "psm.werewolf.solutions/static-release-execution/v1"
RESULT_SCHEMA = "psm.werewolf.solutions/static-release-result/v1"
REQUEST_SCHEMA = "psm.werewolf.solutions/host-helper-request/v1"
RESPONSE_SCHEMA = "psm.werewolf.solutions/host-helper-response/v1"
TARGET_SCHEMA = "psm.werewolf.solutions/control-target/v1"
PAYLOAD_ALGORITHM = "psm-static-tree-sha256@1"
# A Node service bundle: the same tree digest plus executable bits, released by
# the helper's service operation. The artifact's algorithm decides which.
SERVICE_ALGORITHM = "psm-service-tree-sha256@1"
HELPER_OPERATIONS = {PAYLOAD_ALGORITHM: "deploy-static-release", SERVICE_ALGORITHM: "deploy-service-release"}

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$")
PROVIDER_ID_RE = re.compile(r"^[1-9][0-9]{0,30}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
API = "https://api.github.com"


class ContractError(Exception):
    """Refuse the release. The message is written to the log, never to a target."""


def fail(message: str) -> None:
    raise ContractError(message)


def canonical(value: object) -> str:
    """RFC 8785, matching canonicalJson in src/server/deploy/canonical.ts.

    Key ordering is the one difference worth knowing: JavaScript sorts by UTF-16 code
    unit and Python by code point. Every key in these schemas is ASCII, where the two
    orders are identical; a non-BMP key would diverge and must not be introduced.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return json.dumps(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            fail("canonical JSON numbers must be finite")
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        fields = []
        for key in sorted(value):
            if not isinstance(key, str):
                fail("canonical JSON object keys must be strings")
            fields.append(f"{json.dumps(key, ensure_ascii=False, separators=(',', ':'))}:{canonical(value[key])}")
        return "{" + ",".join(fields) + "}"
    fail(f"canonical JSON cannot encode {type(value).__name__}")


def digest(domain: str, value: object) -> str:
    hasher = hashlib.sha256()
    hasher.update(domain.encode("utf-8"))
    hasher.update(b"\0")
    hasher.update(canonical(value).encode("utf-8"))
    return f"sha256:{hasher.hexdigest()}"


def env(name: str) -> str:
    value = os.environ.get(f"PSM_{name.upper()}", "")
    if not value:
        fail(f"dispatch input {name} is missing")
    return value


def match(pattern: re.Pattern[str], value: str, field: str) -> str:
    if not pattern.match(value):
        fail(f"{field} has an invalid format")
    return value


def output(**values: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        for key, value in values.items():
            print(f"{key}={value}")
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                fail(f"step output {key} must be a single line")
            handle.write(f"{key}={value}\n")


def load_contract() -> dict:
    """Parse the contract and prove it is the one PSM approved, then agree with the
    flat inputs. A field present in both must match in both."""
    raw = env("execution_contract_json")
    if len(raw.encode("utf-8")) > 48 * 1024:
        fail("execution contract exceeds 49152 bytes")
    try:
        contract = json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"execution contract is not valid JSON: {error}")
    if not isinstance(contract, dict) or contract.get("schema") != CONTRACT_SCHEMA:
        fail(f"execution contract schema must be {CONTRACT_SCHEMA}")

    expected = env("execution_contract_digest")
    match(DIGEST_RE, expected, "execution_contract_digest")
    actual = digest(CONTRACT_SCHEMA, contract)
    if actual != expected:
        fail("execution contract does not match its approved digest")

    artifact = contract.get("artifact")
    target = contract.get("target")
    intended = contract.get("intendedRelease")
    plan = contract.get("plan")
    if not all(isinstance(item, dict) for item in (artifact, target, intended, plan)):
        fail("execution contract is missing its target, artifact, release or plan")

    for field, contract_value in (
        ("project_id", contract.get("projectId")),
        ("environment_id", contract.get("environmentId")),
        ("unit_id", contract.get("unitId")),
        ("operation", contract.get("operation")),
        ("target_id", target.get("id")),
        ("release_id", intended.get("releaseId")),
        ("plan_digest", plan.get("digest")),
        ("plan_expires_at", plan.get("expiresAt")),
        ("payload_digest", intended.get("payloadDigest")),
        ("source_repository", artifact.get("sourceRepository")),
        ("psm_artifact_id", artifact.get("psmArtifactId")),
        ("github_artifact_id", artifact.get("githubArtifactId")),
        ("producer_run_id", artifact.get("producerRunId")),
        ("payload_algorithm", artifact.get("payloadAlgorithm")),
        ("archive_digest", artifact.get("archiveDigest")),
        ("commit_sha", artifact.get("commitSha")),
        ("version", artifact.get("version")),
    ):
        if env(field) != contract_value:
            fail(f"{field} does not match the execution contract")

    if contract.get("operation") not in ("deploy", "release", "rollback"):
        fail("operation must be deploy, release or rollback")
    if artifact.get("payloadAlgorithm") not in HELPER_OPERATIONS:
        fail(f"payload algorithm must be {PAYLOAD_ALGORITHM} or {SERVICE_ALGORITHM}")
    match(DIGEST_RE, str(target.get("fingerprint", "")), "target.fingerprint")
    match(ID_RE, str(target.get("contractRevision", "")), "target.contractRevision")
    match(COMMIT_RE, env("commit_sha"), "commit_sha")
    match(VERSION_RE, env("version"), "version")
    match(PROVIDER_ID_RE, env("github_artifact_id"), "github_artifact_id")
    match(PROVIDER_ID_RE, env("producer_run_id"), "producer_run_id")
    match(REPOSITORY_RE, env("source_repository"), "source_repository")

    expires = env("plan_expires_at")
    match(TIMESTAMP_RE, expires, "plan_expires_at")
    if datetime.fromisoformat(expires.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        fail("the approved plan expired before the target was contacted")

    pm2 = contract.get("pm2")
    if not isinstance(pm2, dict) or pm2.get("invariant") != "unchanged":
        fail("the PM2 invariant must be unchanged")
    match(DIGEST_RE, str(pm2.get("snapshotDigest", "")), "pm2.snapshotDigest")

    rollback = contract.get("conditionalRollback")
    if not isinstance(rollback, dict) or not isinstance(rollback.get("allowed"), bool):
        fail("the conditional rollback authorization is invalid")
    if rollback["allowed"] != (rollback.get("previousReleaseId") is not None):
        fail("rollback is allowed exactly when a previous release is authorized")
    if rollback["allowed"] and not isinstance(contract.get("expectedCurrentRelease"), dict):
        fail("rollback is authorized without an expected current release to return to")

    probes = contract.get("probes")
    if not isinstance(probes, list) or len(probes) > 32:
        fail("probes must be a list of at most 32 entries")
    if len({probe.get("id") for probe in probes if isinstance(probe, dict)}) != len(probes):
        fail("probe IDs must be unique")
    return contract


def target_file(target_id: str) -> dict:
    """The control-repository target contract at the pinned commit. It is the only thing
    that may name an Environment, and a caller cannot influence which file is read
    beyond the target ID PSM already signed into the contract digest."""
    if not ID_RE.match(target_id) or ".." in target_id or target_id.startswith("/"):
        fail("target_id has an invalid format")
    path = Path("targets") / f"{target_id.replace(':', '__').replace('/', '__')}.json"
    if not path.is_file():
        fail(f"this controller has no target contract for {target_id}")
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schema") != TARGET_SCHEMA:
        fail(f"{path} schema must be {TARGET_SCHEMA}")
    if document.get("targetId") != target_id:
        fail(f"{path} declares a different target")
    for field in ("githubEnvironment", "sshHost", "sshUser", "hostKeyFingerprint", "canonicalRoot", "contractRevision", "helperProtocol"):
        if not isinstance(document.get(field), str) or not document[field]:
            fail(f"{path} is missing {field}")
    if document["helperProtocol"] != REQUEST_SCHEMA:
        fail(f"{path} names a helper protocol this controller does not speak")
    port = document.get("sshPort", 22)
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        fail(f"{path} has an invalid SSH port")
    document["sshPort"] = port
    return document


def command_verify() -> None:
    contract = load_contract()
    document = target_file(env("target_id"))
    # The revision is the one target fact this repository can check on its own. The
    # fingerprint belongs to the host and is checked against the helper's own attestation
    # after it answers, not here.
    if document["contractRevision"] != contract["target"]["contractRevision"]:
        fail("the approved target contract revision is not the one this controller pins")
    output(
        environment=document["githubEnvironment"],
        ssh_host=document["sshHost"],
        ssh_user=document["sshUser"],
        ssh_port=str(document["sshPort"]),
        host_key_fingerprint=document["hostKeyFingerprint"],
    )
    print(f"Contract verified for {contract['target']['id']} in {document['githubEnvironment']}.")


def api_get(path: str, token: str, accept: str = "application/vnd.github+json") -> tuple[bytes, str]:
    request = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Accept": accept,
            "Authorization": f"Bearer {token}",
            "User-Agent": "psm-release-controller",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read(), response.headers.get("content-type", "")
    except urllib.error.HTTPError as error:
        fail(f"GitHub returned HTTP {error.code} for {path}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003
        return None


def download_artifact_zip(path: str, token: str) -> bytes:
    """GitHub answers the artifact download with a 302 to signed storage (and 415 to
    Accept: application/zip). Follow it by hand so the token never leaves GitHub."""
    request = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "psm-release-controller",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        urllib.request.build_opener(_NoRedirect).open(request, timeout=60)
        fail(f"GitHub did not redirect the download for {path}")
    except urllib.error.HTTPError as error:
        if error.code != 302:
            fail(f"GitHub returned HTTP {error.code} for {path}")
        location = error.headers.get("location", "")
    signed = urllib.parse.urlsplit(location)
    if signed.scheme != "https" or not signed.hostname or signed.username or signed.password:
        fail("GitHub returned an unsafe artifact download location")
    storage = urllib.request.Request(location, headers={"User-Agent": "psm-release-controller"})
    try:
        with urllib.request.urlopen(storage, timeout=120) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        fail(f"artifact storage returned HTTP {error.code}")


def command_fetch() -> None:
    """Download exactly the approved artifact, from exactly the approved run, and prove
    it is byte-for-byte what was approved before anything touches the target."""
    token = env("token")
    repository = match(REPOSITORY_RE, env("source_repository"), "source_repository")
    artifact_id = match(PROVIDER_ID_RE, env("github_artifact_id"), "github_artifact_id")
    work = Path(env("work_dir"))
    work.mkdir(parents=True, exist_ok=True)

    described = json.loads(api_get(f"/repos/{repository}/actions/artifacts/{artifact_id}", token)[0])
    if described.get("name") != env("psm_artifact_id"):
        fail("the approved artifact ID does not carry the approved artifact name")
    if described.get("expired") is not False:
        fail("the approved artifact has expired")
    run = described.get("workflow_run") or {}
    if str(run.get("id")) != env("producer_run_id"):
        fail("the approved artifact was not produced by the approved run")
    if run.get("head_sha") != env("commit_sha"):
        fail("the approved artifact was not produced from the approved commit")

    body = download_artifact_zip(f"/repos/{repository}/actions/artifacts/{artifact_id}/zip", token)
    bundle = work / "artifact.zip"
    bundle.write_bytes(body)
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
        if names != ["payload.tar"]:
            fail("the prepared artifact must contain exactly payload.tar")
        with archive.open("payload.tar") as source, open(work / "payload.tar", "wb") as sink:
            while chunk := source.read(1024 * 1024):
                sink.write(chunk)
    bundle.unlink()

    payload = work / "payload.tar"
    if payload.stat().st_size > MAX_ARCHIVE_BYTES:
        fail("the prepared archive is larger than the helper accepts")
    hasher = hashlib.sha256()
    with open(payload, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            hasher.update(chunk)
    observed = f"sha256:{hasher.hexdigest()}"
    if observed != env("archive_digest"):
        fail("the downloaded archive is not the approved archive")

    print(f"Archive verified: {observed} ({payload.stat().st_size} bytes).")


def command_credentials() -> None:
    """Write the deployment key and the verified host key where only this job can read
    them, and refuse a known_hosts entry that does not match the fingerprint the target
    contract pins."""
    work = Path(env("work_dir"))
    work.mkdir(parents=True, exist_ok=True)
    key = work / "id_deploy"
    known = work / "known_hosts"
    key.write_text(os.environ["PSM_SSH_PRIVATE_KEY"].rstrip("\n") + "\n", encoding="utf-8")
    key.chmod(0o600)
    known.write_text(os.environ["PSM_SSH_KNOWN_HOSTS"].rstrip("\n") + "\n", encoding="utf-8")
    known.chmod(0o600)
    listed = subprocess.run(
        ["ssh-keygen", "-lf", str(known)], capture_output=True, text=True, check=False,
    )
    fingerprints = {line.split()[1] for line in listed.stdout.splitlines() if len(line.split()) > 1}
    if env("host_key_fingerprint") not in fingerprints:
        fail("the Environment's known_hosts entry is not the host key this target pins")
    print("Deployment key and verified host key installed.")


def helper_request(work: Path, header: dict, archive: Path, host: str, user: str, port: int) -> dict:
    """One framed request: a big-endian length, the JSON header, then the archive bytes.
    The forced command on the target runs the helper, so there is no command to inject."""
    body = json.dumps(header, separators=(",", ":")).encode("utf-8")
    process = subprocess.Popen(
        [
            "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={work / 'known_hosts'}", "-o", "IdentitiesOnly=yes",
            "-o", "ConnectTimeout=20", "-i", str(work / "id_deploy"), "-p", str(port),
            f"{user}@{host}",
        ],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        process.stdin.write(struct.pack(">I", len(body)))
        process.stdin.write(body)
        with open(archive, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                process.stdin.write(chunk)
        process.stdin.close()
        size_bytes = process.stdout.read(4)
        if len(size_bytes) != 4:
            fail("the target helper returned no response frame")
        size = struct.unpack(">I", size_bytes)[0]
        if not 0 < size <= 512 * 1024:
            fail("the target helper response frame size is invalid")
        raw = process.stdout.read(size)
    finally:
        process.wait(timeout=600)
    if len(raw) != size:
        fail("the target helper response frame is truncated")
    response = json.loads(raw.decode("utf-8"))
    if response.get("schema") != RESPONSE_SCHEMA:
        fail("the target helper response schema is unsupported")
    return response


def release_response(response: dict, contract: dict) -> tuple[str, list, str | None, str]:
    """Interpret the helper's wire result without confusing outcome with code.

    A successful helper response is outcome=succeeded, code=ok. Its data is
    authoritative only when the staged target matches the approved contract.
    """
    detail = str(response.get("detail", ""))[:200]
    if response.get("outcome") != "succeeded" or response.get("code") != "ok":
        return "failed", [], None, detail
    data = response.get("data")
    if not isinstance(data, dict):
        fail("the target helper returned no release result")
    staged = data.get("staged") or {}
    if not isinstance(staged, dict) or staged.get("targetDigest") != contract["target"]["fingerprint"]:
        fail("the target attested a different contract than the one approved")
    return (
        data.get("state", "failed"),
        data.get("verification") or [],
        (data.get("activated") or {}).get("activatedAt") or response.get("observedAt"),
        detail,
    )


def command_release() -> None:
    contract = load_contract()
    document = target_file(env("target_id"))
    work = Path(env("work_dir"))
    artifact = contract["artifact"]
    limits = artifact.get("payloadLimits") or {}
    current = contract.get("expectedCurrentRelease")

    desired = {
        "stage": {
            "releaseId": contract["intendedRelease"]["releaseId"],
            "artifactId": artifact["psmArtifactId"],
            "commitSha": artifact["commitSha"],
            "version": artifact["version"],
            "payloadAlgorithm": artifact["payloadAlgorithm"],
            "payloadDigest": contract["intendedRelease"]["payloadDigest"],
            "archiveDigest": artifact["archiveDigest"],
            "maximumFiles": limits.get("maxFiles"),
            "maximumBytes": limits.get("maxUnpackedBytes"),
        },
        "activate": {
            "releaseId": contract["intendedRelease"]["releaseId"],
            "payloadDigest": contract["intendedRelease"]["payloadDigest"],
            "expectedCurrentReleaseId": current["releaseId"] if current else None,
            "expectedCurrentPayloadDigest": current["payloadDigest"] if current else None,
        },
        "expectedPm2Digest": contract["pm2"]["snapshotDigest"],
        "rollbackAllowed": contract["conditionalRollback"]["allowed"],
        "probes": [helper_probe(probe) for probe in contract["probes"]],
    }
    payload = work / "payload.tar"
    header = {
        "schema": REQUEST_SCHEMA,
        "requestId": env("psm_run_id"),
        "targetId": env("target_id"),
        "operation": HELPER_OPERATIONS[artifact["payloadAlgorithm"]],
        "idempotencyKey": contract["intendedRelease"]["releaseId"],
        "planDigest": env("plan_digest"),
        "expiresAt": env("plan_expires_at"),
        "archiveBytes": payload.stat().st_size,
        "desired": desired,
    }

    state, verification, activated_at, detail = "failed", [], None, ""
    try:
        response = helper_request(
            work, header, payload, document["sshHost"], document["sshUser"], document["sshPort"],
        )
        state, verification, activated_at, detail = release_response(response, contract)
    except ContractError as error:
        detail = str(error)
    finally:
        write_result(work, contract, state, verification, activated_at)
    if state != "activated":
        print(f"Release did not activate: {state} {detail}", file=sys.stderr)
        sys.exit(1)
    print(f"Release {contract['intendedRelease']['releaseId']} activated.")


def helper_probe(probe: dict) -> dict:
    """Only the probe kinds the helper implements, with no field it did not approve."""
    if probe.get("kind") == "http-status@1":
        return {
            "id": probe["id"], "kind": probe["kind"], "url": probe["url"],
            "method": probe.get("method", "GET"),
            "expectedStatuses": probe["expectedStatuses"], "timeoutMs": probe["timeoutMs"],
        }
    if probe.get("kind") == "release-metadata@1":
        return {
            "id": probe["id"], "kind": probe["kind"], "url": probe["url"],
            "expectedCommitSha": probe["expectedCommitSha"],
            "expectedPsmArtifactId": probe["expectedPsmArtifactId"],
            "timeoutMs": probe["timeoutMs"],
        }
    fail(f"probe {probe.get('id')} uses a kind this controller does not support")


def write_result(work: Path, contract: dict, state: str, verification: list, activated_at: str | None) -> None:
    """Exactly the keys parseStaticReleaseResult accepts, in one file PSM reads by name."""
    artifact = contract["artifact"]
    rollback = contract["conditionalRollback"]
    result = {
        "schema": RESULT_SCHEMA,
        "psm_run_id": env("psm_run_id"),
        "project_id": env("project_id"),
        "environment_id": env("environment_id"),
        "unit_id": env("unit_id"),
        "release_id": env("release_id"),
        "previous_release_id": rollback.get("previousReleaseId"),
        "plan_digest": env("plan_digest"),
        "execution_contract_digest": env("execution_contract_digest"),
        "controller_repository": env("controller_repository"),
        "controller_workflow": env("controller_workflow"),
        "controller_ref": env("controller_ref"),
        "controller_commit_sha": env("controller_commit_sha"),
        "provider_run_id": env("provider_run_id"),
        "target_id": env("target_id"),
        "target_fingerprint": contract["target"]["fingerprint"],
        "target_contract_revision": contract["target"]["contractRevision"],
        "psm_artifact_id": artifact["psmArtifactId"],
        "github_artifact_id": artifact["githubArtifactId"],
        "producer_run_id": artifact["producerRunId"],
        "payload_algorithm": artifact["payloadAlgorithm"],
        "payload_digest": artifact["payloadDigest"],
        "archive_digest": artifact["archiveDigest"],
        "state": state,
        "activated_at": activated_at,
        "verification": [
            {"id": item.get("id"), "state": item.get("state"), "code": item.get("code")}
            for item in verification
        ],
    }
    (work / "psm-release-result.json").write_text(json.dumps(result) + "\n", encoding="utf-8")


COMMANDS = {
    "verify": command_verify,
    "fetch": command_fetch,
    "credentials": command_credentials,
    "release": command_release,
}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(f"usage: psm_controller.py {'|'.join(COMMANDS)}", file=sys.stderr)
        sys.exit(2)
    try:
        COMMANDS[sys.argv[1]]()
    except ContractError as error:
        print(f"refused: {error}", file=sys.stderr)
        sys.exit(1)
