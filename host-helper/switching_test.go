package main

import (
	"bytes"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// switchingTarget enrolls two slots whose health depends on the release
// `current` names, and an nginx site that forwards through the upstream file.
func switchingTarget(t *testing.T, broken string) (TargetConfig, *fakeHost) {
	t.Helper()
	var target TargetConfig
	status := func() int {
		if link, _ := os.Readlink(filepath.Join(target.CanonicalRoot, "current")); broken != "" && strings.Contains(link, broken) {
			return http.StatusInternalServerError
		}
		return http.StatusOK
	}
	primary := healthServerFunc(t, status)
	target = serviceTarget(t, primary)
	target.Service.AlternatePort = healthServerFunc(t, status)
	if err := target.validate(); err != nil {
		t.Fatal(err)
	}
	host := installFakeHost(t, target.Service)
	previousDrain := drainWait
	drainWait = func(wait time.Duration) { host.commands = append(host.commands, "drain "+wait.String()) }
	t.Cleanup(func() { drainWait = previousDrain })
	desired := serviceDesiredFor(target, map[string]string{})
	desired.Switching = "health-checked"
	if _, err := reconcileService(target, mustJSON(desired)); err != nil {
		t.Fatal(err)
	}
	site, err := renderProxy(target, proxyIngressDesired{Hostname: target.Hostname, SecurityHeaders: "app-managed@1", MaxBodyMB: 1}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(nginxPath(target)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nginxPath(target), site, 0644); err != nil {
		t.Fatal(err)
	}
	host.commands = nil
	return target, host
}

func (host *fakeHost) index(command string) int {
	host.mu.Lock()
	defer host.mu.Unlock()
	for index, item := range host.commands {
		if item == command {
			return index
		}
	}
	return -1
}

func livePort(t *testing.T, target TargetConfig) int {
	t.Helper()
	live, _, err := liveSlot(target)
	if err != nil {
		t.Fatal(err)
	}
	return live.Port
}

func TestSwitchingContractIsOptionalAndBounded(t *testing.T) {
	target := serviceTarget(t, servicePortMinimum+10)
	if len(serviceSlots(target)) != 1 || strings.Contains(string(mustJSON(target.Service)), "alternatePort") {
		t.Fatal("a contract without an alternate port must keep its single slot and its serialized form")
	}
	for label, mutate := range map[string]func(*ServiceConfig){
		"same port":           func(service *ServiceConfig) { service.AlternatePort = service.Port },
		"port outside range":  func(service *ServiceConfig) { service.AlternatePort = 8080 },
		"drain without slots": func(service *ServiceConfig) { service.DrainSeconds = 5 },
		"long drain":          func(service *ServiceConfig) { service.AlternatePort, service.DrainSeconds = service.Port+1, 61 },
	} {
		copied := *target.Service
		mutate(&copied)
		if err := copied.validate(target); err == nil {
			t.Fatalf("%s was accepted", label)
		}
	}
}

func TestReconcileWritesBothSlotsAndTheUpstream(t *testing.T) {
	target, _ := switchingTarget(t, "")
	primary, err := os.ReadFile(filepath.Join(target.Service.SystemdDir, "psm-svc-handyman-staging.service"))
	if err != nil {
		t.Fatal(err)
	}
	alternate, err := os.ReadFile(filepath.Join(target.Service.SystemdDir, "psm-svc-handyman-staging-alt.service"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(primary, []byte("PORT="+itoa(target.Service.Port))) || !bytes.Contains(alternate, []byte("PORT="+itoa(target.Service.AlternatePort))) {
		t.Fatal("each slot must listen on its own enrolled port")
	}
	if livePort(t, target) != target.Service.Port {
		t.Fatal("a new upstream file must name the primary slot")
	}
	site, _ := os.ReadFile(nginxPath(target))
	if !bytes.Contains(site, []byte("include "+upstreamFile(target)+";")) || !bytes.Contains(site, []byte("proxy_pass http://psm-svc-handyman-staging;")) {
		t.Fatalf("the proxy does not forward through the upstream file:\n%s", site)
	}
	observed, err := observeServiceResource(target, mustJSON(serviceObserveDesired{Kind: "systemd-node-service@1", Entry: "bin/www", HealthPath: "/healthz", StartupTimeoutSeconds: 5, MemoryMaxMB: 256, Switching: "health-checked"}))
	if err != nil || observed.(map[string]any)["state"] != "in-sync" {
		t.Fatalf("reconciled slots are not in sync: %v %v", observed, err)
	}
	restart := serviceDesiredFor(target, map[string]string{})
	if _, err := reconcileService(target, mustJSON(restart)); err == nil || !strings.Contains(err.Error(), "enroll the target again") {
		t.Fatalf("a manifest cannot switch modes without enrollment: %v", err)
	}
	if err := os.WriteFile(upstreamFile(target), []byte(managedHeader+"server 127.0.0.1:41999;\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := liveSlot(target); err == nil {
		t.Fatal("an upstream naming a port outside the contract was accepted")
	}
}

func itoa(value int) string { return strconv.Itoa(value) }

func TestHealthyReleaseTakesTrafficBeforeThePreviousSlotStops(t *testing.T) {
	target, host := switchingTarget(t, "")
	digest, stateDir := "sha256:"+strings.Repeat("b", 64), t.TempDir()
	first, archive, firstPayload := deployRequest(t, "1.0.0", nil, nil)
	if result, err := deployServiceRelease(stateDir, target, digest, first, bytes.NewReader(archive)); err != nil || result.(map[string]any)["state"] != "activated" {
		t.Fatalf("first release: %v %v", result, err)
	}
	if livePort(t, target) != target.Service.AlternatePort {
		t.Fatal("the first release should serve from the slot that was idle")
	}
	host.commands = nil
	previous := "rel_1_0_0"
	second, archive, _ := deployRequest(t, "1.1.0", &previous, &firstPayload)
	if result, err := deployServiceRelease(stateDir, target, digest, second, bytes.NewReader(archive)); err != nil || result.(map[string]any)["state"] != "activated" {
		t.Fatalf("second release: %v %v", result, err)
	}
	if livePort(t, target) != target.Service.Port {
		t.Fatal("the second release should serve from the other slot")
	}
	order := []string{
		"systemctl restart psm-svc-handyman-staging", "nginx -t", "systemctl reload nginx",
		"systemctl enable psm-svc-handyman-staging", "systemctl disable psm-svc-handyman-staging-alt",
		"drain 5s", "systemctl stop psm-svc-handyman-staging-alt",
	}
	last := -1
	for _, command := range order {
		index := host.index(command)
		if index <= last {
			t.Fatalf("%q did not run after the previous step; commands: %v", command, host.commands)
		}
		last = index
	}
	if host.ran("systemctl restart psm-svc-handyman-staging-alt") {
		t.Fatal("the serving slot was restarted")
	}
}

func TestFailingCandidateReceivesNoTraffic(t *testing.T) {
	target, host := switchingTarget(t, "rel_1_1_0")
	digest, stateDir := "sha256:"+strings.Repeat("b", 64), t.TempDir()
	first, archive, firstPayload := deployRequest(t, "1.0.0", nil, nil)
	if _, err := deployServiceRelease(stateDir, target, digest, first, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	serving := livePort(t, target)
	host.commands = nil
	previous := "rel_1_0_0"
	second, archive, _ := deployRequest(t, "1.1.0", &previous, &firstPayload)
	var desired deployReleaseDesired
	if err := decodeDesired(second.Desired, &desired); err != nil {
		t.Fatal(err)
	}
	desired.RollbackAllowed = false
	second.Desired = mustJSON(desired)
	_, err := deployServiceRelease(stateDir, target, digest, second, bytes.NewReader(archive))
	if err == nil || !strings.Contains(err.Error(), "received no traffic") || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("the failed gate was not explained: %v", err)
	}
	if livePort(t, target) != serving {
		t.Fatal("nginx was pointed at a candidate that failed its health gate")
	}
	if host.ran("systemctl reload nginx") || host.ran("systemctl stop psm-svc-handyman-staging-alt") {
		t.Fatalf("the serving slot or nginx was touched: %v", host.commands)
	}
	if !host.ran("systemctl stop psm-svc-handyman-staging") {
		t.Fatal("the failed candidate was left running")
	}
}

func TestFailedGateWithRollbackRestoresThePreviousRelease(t *testing.T) {
	target, _ := switchingTarget(t, "rel_1_1_0")
	digest, stateDir := "sha256:"+strings.Repeat("b", 64), t.TempDir()
	first, archive, firstPayload := deployRequest(t, "1.0.0", nil, nil)
	if _, err := deployServiceRelease(stateDir, target, digest, first, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	previous := "rel_1_0_0"
	second, archive, _ := deployRequest(t, "1.1.0", &previous, &firstPayload)
	result, err := deployServiceRelease(stateDir, target, digest, second, bytes.NewReader(archive))
	if err != nil || result.(map[string]any)["state"] != "rolled-back" {
		t.Fatalf("unhealthy release was not rolled back: %v %v", result, err)
	}
	if active, _ := activeRelease(target); active == nil || active.ReleaseID != previous {
		t.Fatalf("current does not name the previous release: %#v", active)
	}
}

func TestRejectedNginxConfigurationKeepsThePreviousSlot(t *testing.T) {
	target, host := switchingTarget(t, "")
	run := runCommand
	runCommand = func(name string, args ...string) (any, error) {
		result, err := run(name, args...)
		if name == "nginx" {
			return nil, errors.New("nginx: configuration file test failed")
		}
		return result, err
	}
	if err := switchHealthy(target, serviceSlots(target)[0], serviceSlots(target)[1]); err == nil || !strings.Contains(err.Error(), "previous service keeps serving") {
		t.Fatalf("a rejected nginx configuration was not reported: %v", err)
	}
	if livePort(t, target) != target.Service.Port {
		t.Fatal("the upstream file was left pointing at the candidate")
	}
	if host.ran("systemctl reload nginx") || host.ran("systemctl stop psm-svc-handyman-staging") || !host.ran("systemctl stop psm-svc-handyman-staging-alt") {
		t.Fatalf("wrong recovery: %v", host.commands)
	}
}

func TestSwitchWaitsForNginxToUseTheUpstream(t *testing.T) {
	target, host := switchingTarget(t, "")
	if err := os.Remove(nginxPath(target)); err != nil {
		t.Fatal(err)
	}
	if err := restartHealthy(target); err != nil {
		t.Fatal(err)
	}
	if !host.ran("systemctl restart psm-svc-handyman-staging") || host.ran("systemctl restart psm-svc-handyman-staging-alt") || livePort(t, target) != target.Service.Port {
		t.Fatalf("without the upstream in nginx the live slot must restart in place: %v", host.commands)
	}
}
