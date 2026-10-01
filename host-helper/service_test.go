package main

import (
	"archive/tar"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeHost replaces systemctl, the service account lookup and PM2 for one test.
type fakeHost struct {
	mu       sync.Mutex
	commands []string
	active   string
}

func installFakeHost(t *testing.T, service *ServiceConfig) *fakeHost {
	t.Helper()
	host := &fakeHost{active: "active"}
	previousRun, previousLookup, previousPM2 := runCommand, lookupUser, pm2List
	previousChownFile, previousChownPath := chownFile, chownPath
	chownFile = func(*os.File, int, int) error { return nil }
	chownPath = func(string, int, int) error { return nil }
	t.Cleanup(func() { chownFile, chownPath = previousChownFile, previousChownPath })
	runCommand = func(name string, args ...string) (any, error) {
		host.mu.Lock()
		defer host.mu.Unlock()
		host.commands = append(host.commands, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		if name == "systemctl" && len(args) > 0 && args[0] == "show" {
			return map[string]any{"command": name, "result": "ActiveState=" + host.active + "\nSubState=running\nNRestarts=0\nMemoryCurrent=52428800\nMainPID=4242"}, nil
		}
		return map[string]any{"command": name, "result": ""}, nil
	}
	lookupUser = func(name string) (*user.User, error) {
		if name != service.User {
			return nil, errors.New("unknown user")
		}
		return &user.User{Username: name, Uid: strconv.Itoa(int(service.UID)), Gid: strconv.Itoa(int(service.GID))}, nil
	}
	pm2List = func(TargetConfig) ([]byte, error) { return []byte(`[]`), nil }
	t.Cleanup(func() { runCommand, lookupUser, pm2List = previousRun, previousLookup, previousPM2 })
	return host
}

func (host *fakeHost) ran(command string) bool {
	host.mu.Lock()
	defer host.mu.Unlock()
	for _, item := range host.commands {
		if item == command {
			return true
		}
	}
	return false
}

// healthServer answers the health path on a loopback port inside the service range.
func healthServer(t *testing.T, status *int) int {
	return healthServerFunc(t, func() int { return *status })
}

func healthServerFunc(t *testing.T, status func() int) int {
	t.Helper()
	for port := servicePortMinimum + 500; port <= servicePortMaximum; port++ {
		listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.WriteHeader(status())
		})}
		go func() { _ = server.Serve(listener) }()
		t.Cleanup(func() { _ = server.Close() })
		return port
	}
	t.Fatal("no free port in the service range")
	return 0
}

func serviceTarget(t *testing.T, port int) TargetConfig {
	t.Helper()
	target := testTarget(t)
	base := filepath.Dir(filepath.Dir(target.CanonicalRoot))
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	if uid == 0 {
		uid, gid = 1000, 1000
	}
	// The service user must differ from the deploy and role accounts.
	target.DeployUID, target.InfrastructureUIDs, target.ReleaseUIDs = uid+1, []uint32{uid + 1}, []uint32{uid + 2}
	target.Service = &ServiceConfig{
		UnitName: "psm-svc-handyman-staging", User: "psm-s-handyman", UID: uid, GID: gid, Port: port,
		MemoryMaxMB: 256, Entry: "bin/www", HealthPath: "/healthz", StartupTimeoutSeconds: 5,
		SystemdDir: filepath.Join(base, "systemd"), ConfigDir: filepath.Join(base, "services"),
	}
	if err := target.validate(); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"incoming", "releases"} {
		if err := os.MkdirAll(filepath.Join(target.CanonicalRoot, directory), 0755); err != nil {
			t.Fatal(err)
		}
	}
	return target
}

func TestStaticContractDigestIsUnchangedByServiceSupport(t *testing.T) {
	target := testTarget(t)
	canonical, _ := json.Marshal(target)
	if strings.Contains(string(canonical), `"service"`) {
		t.Fatal("a static contract now serializes a service block, which would change every pinned target digest")
	}
}

func TestServiceContractRejectsBroadAuthority(t *testing.T) {
	status := http.StatusOK
	cases := map[string]func(*ServiceConfig, *TargetConfig){
		"port outside the range":     func(service *ServiceConfig, _ *TargetConfig) { service.Port = 3001 },
		"service user is release":    func(service *ServiceConfig, target *TargetConfig) { service.UID = target.ReleaseUIDs[0] },
		"root service":               func(service *ServiceConfig, _ *TargetConfig) { service.UID = 0 },
		"unit outside the namespace": func(service *ServiceConfig, _ *TargetConfig) { service.UnitName = "nginx" },
		"entry escapes the app":      func(service *ServiceConfig, _ *TargetConfig) { service.Entry = "../../bin/sh" },
		"entry with a space":         func(service *ServiceConfig, _ *TargetConfig) { service.Entry = "bin/www --inspect" },
	}
	for name, change := range cases {
		target := serviceTarget(t, healthServer(t, &status))
		change(target.Service, &target)
		if err := target.validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestEnvironmentRefusesReservedNamesAndControlCharacters(t *testing.T) {
	for _, name := range []string{"PORT", "HOST", "NODE_OPTIONS", "LD_PRELOAD", "PSM_TOKEN", "PATH", "lower"} {
		if err := validateEnvironment(map[string]string{name: "x"}); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if err := validateEnvironment(map[string]string{"API_KEY": "a\nPORT=1"}); err == nil {
		t.Error("a newline could inject another variable")
	}
	if err := validateEnvironment(map[string]string{"NODE_ENV": "production", "API_KEY": `k"e\y$1`}); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "env")
	values := map[string]string{"API_KEY": `k"e\y$1`, "NODE_ENV": "production"}
	if err := os.WriteFile(filename, renderEnvironmentFile(values), 0600); err != nil {
		t.Fatal(err)
	}
	parsed, err := environmentValues(filename)
	if err != nil || parsed["API_KEY"] != values["API_KEY"] || len(parsed) != 2 {
		t.Fatalf("environment file did not round-trip: %v %v", parsed, err)
	}
}

func TestReconcileServiceWritesOwnedUnitAndConfig(t *testing.T) {
	status := http.StatusOK
	target := serviceTarget(t, healthServer(t, &status))
	host := installFakeHost(t, target.Service)
	desired := mustJSON(serviceDesiredFor(target, map[string]string{"NODE_ENV": "production", "WEREWOLF_API_URL": "https://staging.werewolf.solutions/api/v1"}))
	observe := func(config map[string]string) string {
		t.Helper()
		result, err := observeResource(target, mustJSON(serviceObserveDesired{Kind: "systemd-node-service@1", Entry: "bin/www", HealthPath: "/healthz", StartupTimeoutSeconds: target.Service.StartupTimeoutSeconds, MemoryMaxMB: 256, Config: config}))
		if err != nil {
			t.Fatal(err)
		}
		return result.(map[string]any)["state"].(string)
	}
	if state := observe(map[string]string{"NODE_ENV": "production"}); state != "create" {
		t.Fatalf("expected create, got %s", state)
	}
	if _, err := reconcileService(target, desired); err != nil {
		t.Fatal(err)
	}
	unitFile, configFile, _ := serviceFiles(target)
	unit, _ := os.ReadFile(unitFile)
	for _, line := range []string{"User=psm-s-handyman", fmt.Sprintf("Environment=PORT=%d", target.Service.Port), "Environment=HOST=127.0.0.1",
		"ExecStart=" + target.CanonicalRoot + "/current/runtime/bin/node bin/www", "MemoryMax=256M", "ProtectSystem=strict", "ReadWritePaths=" + target.CanonicalRoot + "/state"} {
		if !strings.Contains(string(unit), line+"\n") {
			t.Errorf("unit lacks %q", line)
		}
	}
	if info, err := os.Stat(configFile); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("config file is not private: %v %v", info, err)
	}
	if !host.ran("systemctl daemon-reload") || !host.ran("systemctl enable psm-svc-handyman-staging") {
		t.Fatalf("unit was not loaded and enabled: %v", host.commands)
	}
	if host.ran("systemctl restart psm-svc-handyman-staging") {
		t.Fatal("a service with no release was restarted")
	}
	if state := observe(map[string]string{"NODE_ENV": "production", "WEREWOLF_API_URL": "https://staging.werewolf.solutions/api/v1"}); state != "in-sync" {
		t.Fatalf("expected in-sync, got %s", state)
	}
	if state := observe(map[string]string{"NODE_ENV": "production"}); state != "update" {
		t.Fatalf("a config change was not detected: %s", state)
	}
	// A unit PSM did not write is never replaced.
	if err := os.WriteFile(unitFile, []byte("[Service]\nExecStart=/bin/true\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcileService(target, desired); err == nil {
		t.Fatal("a foreign unit file was replaced")
	}
}

func TestSecretsAreWrittenPrivatelyAndObservedOnlyAsKeyedFingerprints(t *testing.T) {
	status := http.StatusOK
	target := serviceTarget(t, healthServer(t, &status))
	installFakeHost(t, target.Service)
	if _, err := reconcileService(target, mustJSON(serviceDesiredFor(target, map[string]string{"NODE_ENV": "production"}))); err != nil {
		t.Fatal(err)
	}
	result, err := reconcileServiceSecrets(target, mustJSON(serviceSecretsDesired{Values: map[string]string{"API_KEY": "sk-live-1234", "BUSINESS_ID": "biz_42"}}))
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(result); strings.Contains(string(raw), "sk-live-1234") {
		t.Fatal("a secret value left the host in a response")
	}
	_, _, secretsFile := serviceFiles(target)
	if info, err := os.Stat(secretsFile); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("secrets file is not private: %v %v", info, err)
	}
	salt := strings.Repeat("ab", 16)
	observed, err := observeResource(target, mustJSON(serviceObserveDesired{Kind: "service-secrets@1", Names: []string{"API_KEY", "BUSINESS_ID", "MISSING"}, Salt: salt}))
	if err != nil {
		t.Fatal(err)
	}
	fingerprints := observed.(map[string]any)["fingerprints"].(map[string]any)
	key, _ := hex.DecodeString(salt)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("sk-live-1234"))
	if fingerprints["API_KEY"] != "hmac-sha256:"+hex.EncodeToString(mac.Sum(nil)) {
		t.Fatalf("fingerprint differs: %v", fingerprints["API_KEY"])
	}
	if fingerprints["MISSING"] != nil || observed.(map[string]any)["state"] != "create" {
		t.Fatalf("a missing secret was not reported: %v", observed)
	}
	if _, err := reconcileService(target, mustJSON(serviceDesiredFor(target, map[string]string{"API_KEY": "public"}))); err == nil {
		t.Fatal("a name was accepted as both config and secret")
	}
}

func TestLoopbackCheckRefusesPublicListeners(t *testing.T) {
	status := http.StatusOK
	port := healthServer(t, &status)
	if err := serviceListensOnLoopbackOnly(port); err != nil {
		t.Fatal(err)
	}
	public, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Skip("cannot open a wildcard listener here")
	}
	defer public.Close()
	if err := serviceListensOnLoopbackOnly(public.Addr().(*net.TCPAddr).Port); err == nil {
		t.Fatal("a wildcard listener was accepted")
	}
	if err := serviceListensOnLoopbackOnly(servicePortMinimum + 1); err == nil && port != servicePortMinimum+1 {
		t.Fatal("a port with no listener was accepted")
	}
}

// serviceArchive builds bundle/{version.json,app/bin/www,runtime/bin/node}.
func serviceArchive(t *testing.T, version string) ([]byte, string) {
	t.Helper()
	files := map[string]struct {
		content []byte
		mode    int64
	}{
		"bundle/version.json":     {[]byte(`{"version":"` + version + `"}`), 0644},
		"bundle/app/bin/www":      {[]byte("require('http')"), 0644},
		"bundle/runtime/bin/node": {[]byte("ELF " + version), 0755},
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	tree := t.TempDir()
	for _, name := range names {
		file := files[name]
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: file.mode, Size: int64(len(file.content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = writer.Write(file.content)
		local := filepath.Join(tree, strings.TrimPrefix(name, "bundle/"))
		_ = os.MkdirAll(filepath.Dir(local), 0755)
		if err := os.WriteFile(local, file.content, os.FileMode(file.mode)); err != nil {
			t.Fatal(err)
		}
	}
	_ = writer.Close()
	digest, _, _, err := treeDigest(serviceAlgorithm, tree, 100, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	return output.Bytes(), digest
}

func deployRequest(t *testing.T, version string, previous *string, previousDigest *string) (Request, []byte, string) {
	t.Helper()
	archive, payload := serviceArchive(t, version)
	archiveDigest := sha256.Sum256(archive)
	desired := deployReleaseDesired{
		Stage: stageDesired{ReleaseID: "rel_" + strings.ReplaceAll(version, ".", "_"), ArtifactID: "artifact_" + strings.ReplaceAll(version, ".", "_"),
			CommitSHA: strings.Repeat("a", 40), Version: version, PayloadAlgorithm: serviceAlgorithm, PayloadDigest: payload,
			ArchiveDigest: "sha256:" + hex.EncodeToString(archiveDigest[:]), MaximumFiles: 100, MaximumBytes: 1_000_000},
		ExpectedPM2Digest: emptyPM2Digest(t), RollbackAllowed: true,
	}
	desired.Activate = activateDesired{ReleaseID: desired.Stage.ReleaseID, PayloadDigest: payload, ExpectedCurrentReleaseID: previous, ExpectedCurrentPayloadDigest: previousDigest}
	return Request{IdempotencyKey: "deployment:run_" + version + ":unit:web#staged", ArchiveBytes: int64(len(archive)), Desired: mustJSON(desired)}, archive, payload
}

func emptyPM2Digest(t *testing.T) string {
	t.Helper()
	canonical, _ := json.Marshal([]struct{ Name, Status, Script string }{})
	digest := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func TestServiceDeployActivatesHealthyAndRollsBackUnhealthy(t *testing.T) {
	var target TargetConfig
	// Release 1.1.0 is broken: whatever `current` points to decides the answer.
	port := healthServerFunc(t, func() int {
		if link, _ := os.Readlink(filepath.Join(target.CanonicalRoot, "current")); strings.Contains(link, "rel_1_1_0") {
			return http.StatusInternalServerError
		}
		return http.StatusOK
	})
	target = serviceTarget(t, port)
	host := installFakeHost(t, target.Service)
	targetDigest := "sha256:" + strings.Repeat("b", 64)
	stateDir := t.TempDir()

	first, archive, firstPayload := deployRequest(t, "1.0.0", nil, nil)
	result, err := deployServiceRelease(stateDir, target, targetDigest, first, bytes.NewReader(archive))
	if err != nil || result.(map[string]any)["state"] != "activated" {
		t.Fatalf("healthy first release was not activated: %v %v", result, err)
	}
	if !host.ran("systemctl restart psm-svc-handyman-staging") {
		t.Fatal("activation did not restart the unit")
	}
	node, err := os.Stat(filepath.Join(target.CanonicalRoot, "current", "runtime", "bin", "node"))
	if err != nil || node.Mode().Perm() != 0755 {
		t.Fatalf("bundled runtime is not executable: %v %v", node, err)
	}

	previous := "rel_1_0_0"
	second, archive, _ := deployRequest(t, "1.1.0", &previous, &firstPayload)
	result, err = deployServiceRelease(stateDir, target, targetDigest, second, bytes.NewReader(archive))
	if err != nil || result.(map[string]any)["state"] != "rolled-back" {
		t.Fatalf("unhealthy release was not rolled back: %v %v", result, err)
	}
	active, _ := activeRelease(target)
	if active == nil || active.ReleaseID != previous {
		t.Fatalf("current does not point at the previous release: %#v", active)
	}
	health := result.(map[string]any)["verification"].([]map[string]any)[0]
	if health["state"] != "failed" || !strings.Contains(fmt.Sprint(health["detail"]), "HTTP 500") {
		t.Fatalf("the failed health check is not explained: %v", health)
	}
}

func TestFirstReleaseThatNeverBecomesHealthyIsStopped(t *testing.T) {
	status := http.StatusServiceUnavailable
	target := serviceTarget(t, healthServer(t, &status))
	host := installFakeHost(t, target.Service)
	request, archive, _ := deployRequest(t, "1.0.0", nil, nil)
	if _, err := deployServiceRelease(t.TempDir(), target, "sha256:"+strings.Repeat("b", 64), request, bytes.NewReader(archive)); err == nil {
		t.Fatal("an unhealthy first release was reported as deployed")
	}
	if !host.ran("systemctl stop psm-svc-handyman-staging") {
		t.Fatal("an unhealthy first release was left running")
	}
}

func TestStaticAndServiceOperationsDoNotCross(t *testing.T) {
	status := http.StatusOK
	service := serviceTarget(t, healthServer(t, &status))
	request := Request{Operation: "stage-static-release", Desired: json.RawMessage(`{}`)}
	if _, err := executeOperation(t.TempDir(), service, "sha256:"+strings.Repeat("b", 64), request, bytes.NewReader(nil)); err == nil || !strings.Contains(err.Error(), "service") {
		t.Fatalf("a static release was accepted on a service target: %v", err)
	}
	static := testTarget(t)
	request = Request{Operation: "reconcile-service", Desired: json.RawMessage(`{"config":{}}`)}
	if _, err := executeOperation(t.TempDir(), static, "sha256:"+strings.Repeat("b", 64), request, bytes.NewReader(nil)); err == nil {
		t.Fatal("a service operation was accepted on a static target")
	}
	proxy, err := renderProxy(service, proxyIngressDesired{Hostname: service.Hostname, SecurityHeaders: "app-managed@1", MaxBodyMB: 10}, true)
	if err != nil || !strings.Contains(string(proxy), fmt.Sprintf("proxy_pass http://127.0.0.1:%d;", service.Service.Port)) {
		t.Fatalf("proxy does not forward to the contract port: %v", err)
	}
}

func serviceDesiredFor(target TargetConfig, config map[string]string) serviceDesired {
	service := target.Service
	return serviceDesired{Entry: service.Entry, HealthPath: service.HealthPath, StartupTimeoutSeconds: service.StartupTimeoutSeconds, MemoryMaxMB: service.MemoryMaxMB, Config: config}
}

func TestServiceDesiredCannotWidenTheContract(t *testing.T) {
	status := http.StatusOK
	target := serviceTarget(t, healthServer(t, &status))
	installFakeHost(t, target.Service)
	desired := serviceDesiredFor(target, map[string]string{})
	desired.MemoryMaxMB = 2048
	if _, err := reconcileService(target, mustJSON(desired)); err == nil {
		t.Fatal("a manifest raised the enrolled memory limit")
	}
	observed, err := observeResource(target, mustJSON(serviceObserveDesired{Kind: "systemd-node-service@1", Entry: "server.js", HealthPath: "/healthz", StartupTimeoutSeconds: 5, MemoryMaxMB: 256}))
	if err != nil || observed.(map[string]any)["state"] != "conflict" {
		t.Fatalf("a different entry point was not reported as a conflict: %v %v", observed, err)
	}
}

// The same tree and digest are pinned in src/server/deploy/node-service-recipe.test.ts:
// the build template and this helper must agree byte for byte.
func TestServiceDigestGoldenVector(t *testing.T) {
	root := t.TempDir()
	for name, file := range map[string]struct {
		content string
		mode    os.FileMode
	}{
		"version.json":     {"alpha\n", 0644},
		"app/bin/www":      {"require('./app')\n", 0644},
		"runtime/bin/node": {"ELF\n", 0755},
	} {
		path := filepath.Join(root, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(path), 0755)
		if err := os.WriteFile(path, []byte(file.content), file.mode); err != nil {
			t.Fatal(err)
		}
		_ = os.Chmod(path, file.mode)
	}
	digest, files, size, err := treeDigest(serviceAlgorithm, root, 10, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if digest != "sha256:69dd7860f326de5e41d8ec74256c7d3725e9272ec05b9cc9d96bbcda23e8fa5b" || files != 3 || size != 27 {
		t.Fatalf("service digest changed: %s %d %d", digest, files, size)
	}
}

func TestHostWithoutPM2HasAnEmptyProcessSet(t *testing.T) {
	previous := pm2List
	t.Cleanup(func() { pm2List = previous })
	pm2List = func(TargetConfig) ([]byte, error) {
		return nil, exec.Command("sh", "-c", "exit 127").Run()
	}
	snapshot, err := pm2Snapshot(testTarget(t))
	if err != nil {
		t.Fatalf("a host without pm2 failed the invariant: %v", err)
	}
	canonical, _ := json.Marshal([]struct{ Name, Status, Script string }{})
	digest := sha256.Sum256(canonical)
	if snapshot.(map[string]any)["digest"] != "sha256:"+hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected digest %v", snapshot)
	}
	pm2List = func(TargetConfig) ([]byte, error) {
		return nil, exec.Command("sh", "-c", "echo boom >&2; exit 1").Run()
	}
	if _, err := pm2Snapshot(testTarget(t)); err == nil {
		t.Fatal("a failing pm2 was treated as absent")
	}
}
