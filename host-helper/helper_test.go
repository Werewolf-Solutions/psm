package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func testTarget(t *testing.T) TargetConfig {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "www", "todo.werewolf.solutions")
	if err := os.MkdirAll(filepath.Dir(root), 0755); err != nil {
		t.Fatal(err)
	}
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	if uid == 0 {
		uid = 1000
	}
	if gid == 0 {
		gid = 1000
	}
	target := TargetConfig{
		Schema: targetSchema, Revision: "controller-v0.1.0", TargetID: "target_todo_production",
		ProjectID: "prj_e4713173923933470bd3", EnvironmentID: "production", UnitID: "web",
		CanonicalRoot: root, AllowedRootPrefix: filepath.Dir(root), Hostname: "todo.werewolf.solutions",
		DeployUID: uid, DeployGID: gid, InfrastructureUIDs: []uint32{uid}, ReleaseUIDs: []uint32{uid},
		CertbotEmail: "ops@werewolf.solutions", PM2User: "deploy", PM2Home: filepath.Join(base, "pm2"),
		RetainReleases: 5, NginxAvailableDir: filepath.Join(base, "nginx-available"),
		NginxEnabledDir: filepath.Join(base, "nginx-enabled"), AcmeWebroot: filepath.Join(base, "certbot"),
	}
	if err := target.validate(); err != nil {
		t.Fatal(err)
	}
	return target
}

func TestTargetContractRejectsBroadOrRootAuthority(t *testing.T) {
	target := testTarget(t)
	target.CanonicalRoot = target.AllowedRootPrefix
	if err := target.validate(); err == nil {
		t.Fatal("expected broad root to fail")
	}
	target = testTarget(t)
	target.ReleaseUIDs = []uint32{0}
	if err := target.validate(); err == nil {
		t.Fatal("expected root caller role to fail")
	}
}

func TestFramedProtocolRejectsUnknownFields(t *testing.T) {
	request := map[string]any{"schema": requestSchema, "requestId": "req_1", "targetId": "target_todo", "operation": "observe-target", "desired": map[string]any{}, "surprise": true}
	raw, _ := json.Marshal(request)
	var frame bytes.Buffer
	_ = binary.Write(&frame, binary.BigEndian, uint32(len(raw)))
	frame.Write(raw)
	if _, _, err := readFrame(&frame); err == nil {
		t.Fatal("expected unknown field to fail")
	}
}

func TestPayloadDigestHasStableGoldenVector(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("alpha\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "b.txt"), []byte("beta\n"), 0644); err != nil {
		t.Fatal(err)
	}
	digest, files, size, err := payloadDigest(root, 10, 1_000)
	if err != nil {
		t.Fatal(err)
	}
	if digest != "sha256:c8763c9e1c5f807d726c22bfedddf925adbd3d5184e16f6fd14bfdccee289b70" {
		t.Fatalf("unexpected digest %s", digest)
	}
	if files != 2 || size != 11 {
		t.Fatalf("unexpected counts %d %d", files, size)
	}
}

func tarPayload(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	keys := make([]string, 0, len(entries))
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, name := range keys {
		value := entries[name]
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: int64(len(value)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestStageVerifiesBothDigestsAndActivationUsesCAS(t *testing.T) {
	target := testTarget(t)
	if err := os.MkdirAll(filepath.Join(target.CanonicalRoot, "incoming"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(target.CanonicalRoot, "releases"), 0755); err != nil {
		t.Fatal(err)
	}
	archive := tarPayload(t, map[string][]byte{
		"site/index.html":   []byte("hello"),
		"site/version.json": []byte(`{"version":"0.5.2"}`),
	})
	stagingRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(stagingRoot, "index.html"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagingRoot, "version.json"), []byte(`{"version":"0.5.2"}`), 0644); err != nil {
		t.Fatal(err)
	}
	payload, _, _, err := payloadDigest(stagingRoot, 10, 1_000)
	if err != nil {
		t.Fatal(err)
	}
	archiveHash := sha256.Sum256(archive)
	desired := stageDesired{ReleaseID: "rel_todo_052", ArtifactID: "artifact_todo_052", CommitSHA: strings.Repeat("a", 40), Version: "0.5.2", PayloadAlgorithm: payloadAlgorithm, PayloadDigest: payload, ArchiveDigest: "sha256:" + hex.EncodeToString(archiveHash[:]), MaximumFiles: 10, MaximumBytes: 1_000}
	desiredRaw, _ := json.Marshal(desired)
	request := Request{IdempotencyKey: "deployment:run_1:unit:web#staged", ArchiveBytes: int64(len(archive)), Desired: desiredRaw}
	targetDigest := "sha256:" + strings.Repeat("b", 64)
	if _, err := stageRelease(target, targetDigest, request, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	activationRaw, _ := json.Marshal(activateDesired{ReleaseID: desired.ReleaseID, PayloadDigest: payload})
	if _, err := activateRelease(t.TempDir(), target, targetDigest, activationRaw); err != nil {
		t.Fatal(err)
	}
	active, err := activeRelease(target)
	if err != nil || active == nil || active.ReleaseID != desired.ReleaseID {
		t.Fatalf("activation failed: %#v %v", active, err)
	}
	wrong := "rel_other"
	desired.ReleaseID = "rel_todo_053"
	desired.ArtifactID = "artifact_todo_053"
	desiredRaw, _ = json.Marshal(desired)
	request = Request{IdempotencyKey: "deployment:run_2:unit:web#staged", ArchiveBytes: int64(len(archive)), Desired: desiredRaw}
	if _, err := stageRelease(target, targetDigest, request, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	activationRaw, _ = json.Marshal(activateDesired{ReleaseID: desired.ReleaseID, PayloadDigest: payload, ExpectedCurrentReleaseID: &wrong, ExpectedCurrentPayloadDigest: &payload})
	if _, err := activateRelease(t.TempDir(), target, targetDigest, activationRaw); err == nil {
		t.Fatal("expected compare-and-swap failure")
	}
}

func TestArchiveLinksAreRejected(t *testing.T) {
	target := testTarget(t)
	_ = os.MkdirAll(filepath.Join(target.CanonicalRoot, "incoming"), 0755)
	_ = os.MkdirAll(filepath.Join(target.CanonicalRoot, "releases"), 0755)
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	_ = writer.WriteHeader(&tar.Header{Name: "site/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"})
	_ = writer.Close()
	archiveHash := sha256.Sum256(output.Bytes())
	desiredRaw, _ := json.Marshal(stageDesired{ReleaseID: "rel_bad", ArtifactID: "artifact_bad", CommitSHA: strings.Repeat("a", 40), Version: "0.1.1", PayloadAlgorithm: payloadAlgorithm, PayloadDigest: "sha256:" + strings.Repeat("c", 64), ArchiveDigest: "sha256:" + hex.EncodeToString(archiveHash[:]), MaximumFiles: 10, MaximumBytes: 1_000})
	request := Request{IdempotencyKey: "deployment:run:link", ArchiveBytes: int64(output.Len()), Desired: desiredRaw}
	if _, err := stageRelease(target, "sha256:"+strings.Repeat("b", 64), request, bytes.NewReader(output.Bytes())); err == nil {
		t.Fatal("expected symlink refusal")
	}
}

func TestRequestExpiryAndCorrelationAreFailClosed(t *testing.T) {
	target := testTarget(t)
	request := Request{Schema: requestSchema, RequestID: "req_1", TargetID: target.TargetID, Operation: "reload-nginx", Desired: json.RawMessage(`{}`), IdempotencyKey: "deployment:run:reload", PlanDigest: "sha256:" + strings.Repeat("a", 64), ExpiresAt: time.Now().Add(-time.Minute).Format(time.RFC3339)}
	if err := validateRequest(request, target); err == nil {
		t.Fatal("expected expired request to fail")
	}
	request.ExpiresAt = time.Now().Add(time.Minute).Format(time.RFC3339)
	if err := validateRequest(request, target); err != nil {
		t.Fatal(err)
	}
}

func TestShareRuntimeDirectoryRefusesSharedDirectories(t *testing.T) {
	for _, directory := range []string{"/", "/run", "/tmp", "/var/run/", "/dev/shm"} {
		if err := shareRuntimeDirectory(directory, 998); err == nil {
			t.Fatalf("%s was accepted", directory)
		}
	}
	// A directory this (non-root) test process owns is not root-owned either.
	if os.Geteuid() != 0 {
		if err := shareRuntimeDirectory(t.TempDir(), 998); err == nil {
			t.Fatal("a non-root-owned directory was accepted")
		}
	}
}
