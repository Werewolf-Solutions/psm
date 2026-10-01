package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type releaseDirectoryDesired struct {
	Root           string `json:"root"`
	RetainReleases int    `json:"retainReleases"`
}

type certificateDesired struct {
	Hostname string `json:"hostname"`
	Renewal  string `json:"renewal"`
}

type observeDesired struct {
	Kind            string   `json:"kind"`
	Root            string   `json:"root,omitempty"`
	RetainReleases  int      `json:"retainReleases,omitempty"`
	Hostname        string   `json:"hostname,omitempty"`
	DocumentRoot    string   `json:"documentRoot,omitempty"`
	SPAFallback     bool     `json:"spaFallback,omitempty"`
	DenyPrefixes    []string `json:"denyPrefixes,omitempty"`
	CachePolicy     string   `json:"cachePolicy,omitempty"`
	SecurityHeaders string   `json:"securityHeaders,omitempty"`
	Renewal         string   `json:"renewal,omitempty"`
	TLS             *bool    `json:"tls,omitempty"`
}

type stageDesired struct {
	ReleaseID        string `json:"releaseId"`
	ArtifactID       string `json:"artifactId"`
	CommitSHA        string `json:"commitSha"`
	Version          string `json:"version"`
	PayloadAlgorithm string `json:"payloadAlgorithm"`
	PayloadDigest    string `json:"payloadDigest"`
	ArchiveDigest    string `json:"archiveDigest"`
	MaximumFiles     int    `json:"maximumFiles"`
	MaximumBytes     int64  `json:"maximumBytes"`
}

type activateDesired struct {
	ReleaseID                    string  `json:"releaseId"`
	PayloadDigest                string  `json:"payloadDigest"`
	ExpectedCurrentReleaseID     *string `json:"expectedCurrentReleaseId"`
	ExpectedCurrentPayloadDigest *string `json:"expectedCurrentPayloadDigest"`
}

type pm2CompareDesired struct {
	ExpectedDigest string `json:"expectedDigest"`
}

type executorProbe struct {
	ID                    string `json:"id"`
	Kind                  string `json:"kind"`
	URL                   string `json:"url"`
	Method                string `json:"method,omitempty"`
	ExpectedStatuses      []int  `json:"expectedStatuses,omitempty"`
	ExpectedCommitSHA     string `json:"expectedCommitSha,omitempty"`
	ExpectedPSMArtifactID string `json:"expectedPsmArtifactId,omitempty"`
	TimeoutMS             int    `json:"timeoutMs"`
}

type deployReleaseDesired struct {
	Stage             stageDesired    `json:"stage"`
	Activate          activateDesired `json:"activate"`
	ExpectedPM2Digest string          `json:"expectedPm2Digest"`
	RollbackAllowed   bool            `json:"rollbackAllowed"`
	Probes            []executorProbe `json:"probes"`
}

type releaseReceipt struct {
	Schema           string `json:"schema"`
	TargetID         string `json:"targetId"`
	TargetDigest     string `json:"targetDigest"`
	ReleaseID        string `json:"releaseId"`
	ArtifactID       string `json:"artifactId"`
	CommitSHA        string `json:"commitSha"`
	Version          string `json:"version"`
	PayloadAlgorithm string `json:"payloadAlgorithm"`
	PayloadDigest    string `json:"payloadDigest"`
	ArchiveDigest    string `json:"archiveDigest"`
	FileCount        int    `json:"fileCount"`
	PayloadBytes     int64  `json:"payloadBytes"`
	StagedAt         string `json:"stagedAt"`
}

func executeOperation(stateDir string, target TargetConfig, targetDigest string, request Request, archive io.Reader) (any, error) {
	switch request.Operation {
	case "observe-resource":
		return observeResource(target, request.Desired)
	case "observe-target", "list-releases":
		return observeTarget(target, targetDigest)
	case "reconcile-release-directory":
		return reconcileReleaseDirectory(target, request.Desired)
	case "reconcile-ingress-http":
		return reconcileIngress(target, request.Desired, false)
	case "reconcile-ingress-tls":
		return reconcileIngress(target, request.Desired, true)
	case "reconcile-certificate":
		return reconcileCertificate(target, request.Desired)
	case "validate-nginx":
		return commandResult("nginx", "-t")
	case "reload-nginx":
		if _, err := commandResult("nginx", "-t"); err != nil {
			return nil, err
		}
		return commandResult("systemctl", "reload", "nginx")
	case "snapshot-pm2":
		return pm2Snapshot(target)
	case "compare-pm2":
		return comparePM2(target, request.Desired)
	case "stage-static-release":
		if err := requireStatic(target); err != nil {
			return nil, err
		}
		return stageRelease(target, targetDigest, request, archive)
	case "deploy-static-release":
		if err := requireStatic(target); err != nil {
			return nil, err
		}
		return deployStaticRelease(stateDir, target, targetDigest, request, archive)
	case "activate-static-release", "rollback-static-release":
		if err := requireStatic(target); err != nil {
			return nil, err
		}
		return activateRelease(stateDir, target, targetDigest, request.Desired)
	case "reconcile-service":
		return reconcileService(target, request.Desired)
	case "reconcile-service-secrets":
		return reconcileServiceSecrets(target, request.Desired)
	case "observe-service":
		return observeService(target, targetDigest)
	case "deploy-service-release":
		return deployServiceRelease(stateDir, target, targetDigest, request, archive)
	case "activate-service-release", "rollback-service-release":
		return activateServiceRelease(stateDir, target, targetDigest, request.Desired)
	default:
		return nil, errors.New("operation is unsupported")
	}
}

func runExecutorProbe(target TargetConfig, probe executorProbe) (map[string]any, error) {
	if !idPattern.MatchString(probe.ID) || probe.TimeoutMS < 100 || probe.TimeoutMS > 60000 {
		return nil, errors.New("executor probe identity or timeout is invalid")
	}
	parsed, err := url.Parse(probe.URL)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), target.Hostname) || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("executor probe URL is outside the enrolled hostname")
	}
	method := probe.Method
	if probe.Kind == "release-metadata@1" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead {
		return nil, errors.New("executor probe method is invalid")
	}
	client := &http.Client{
		Timeout: time.Duration(probe.TimeoutMS) * time.Millisecond,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 || !strings.EqualFold(request.URL.Hostname(), target.Hostname) || request.URL.Scheme != "https" {
				return errors.New("probe redirect refused")
			}
			return nil
		},
	}
	request, _ := http.NewRequest(method, parsed.String(), nil)
	request.Header.Set("User-Agent", "psm-host-helper/1")
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("executor probe request failed")
	}
	defer response.Body.Close()
	result := map[string]any{"id": probe.ID, "status": response.StatusCode}
	switch probe.Kind {
	case "http-status@1":
		matched := false
		for _, status := range probe.ExpectedStatuses {
			if status == response.StatusCode {
				matched = true
			}
		}
		if !matched {
			return result, errors.New("HTTP status probe failed")
		}
	case "release-metadata@1":
		if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(probe.ExpectedCommitSHA) || !idPattern.MatchString(probe.ExpectedPSMArtifactID) || response.StatusCode != http.StatusOK {
			return result, errors.New("release metadata probe contract failed")
		}
		limited, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
		if err != nil || len(limited) > 1024*1024 {
			return result, errors.New("release metadata response is invalid")
		}
		var metadata struct {
			Commit        string `json:"commit"`
			PSMArtifactID string `json:"psmArtifactId"`
		}
		if err := json.Unmarshal(limited, &metadata); err != nil || metadata.Commit != probe.ExpectedCommitSHA || metadata.PSMArtifactID != probe.ExpectedPSMArtifactID {
			return result, errors.New("served release metadata differs from the approved artifact")
		}
	default:
		return nil, errors.New("executor probe kind is unsupported")
	}
	return result, nil
}

func deployStaticRelease(stateDir string, target TargetConfig, targetDigest string, request Request, archive io.Reader) (any, error) {
	var desired deployReleaseDesired
	if err := decodeDesired(request.Desired, &desired); err != nil {
		return nil, err
	}
	if !digestPattern.MatchString(desired.ExpectedPM2Digest) || len(desired.Probes) > 64 {
		return nil, errors.New("deployment invariant contract is invalid")
	}
	if _, err := comparePM2(target, mustJSON(pm2CompareDesired{ExpectedDigest: desired.ExpectedPM2Digest})); err != nil {
		return nil, err
	}
	stageRequest := request
	stageRequest.Operation = "stage-static-release"
	stageRequest.Desired = mustJSON(desired.Stage)
	staged, err := stageRelease(target, targetDigest, stageRequest, archive)
	if err != nil {
		return nil, err
	}
	activated, err := activateRelease(stateDir, target, targetDigest, mustJSON(desired.Activate))
	if err != nil {
		return nil, err
	}
	verification := []map[string]any{}
	verificationFailed := false
	if _, err := comparePM2(target, mustJSON(pm2CompareDesired{ExpectedDigest: desired.ExpectedPM2Digest})); err != nil {
		verificationFailed = true
	}
	for _, probe := range desired.Probes {
		_, probeErr := runExecutorProbe(target, probe)
		state, code := "passed", "ok"
		if probeErr != nil {
			state, code, verificationFailed = "failed", "probe-failed", true
		}
		verification = append(verification, map[string]any{"id": probe.ID, "state": state, "code": code})
	}
	state := "activated"
	if verificationFailed {
		if !desired.RollbackAllowed || desired.Activate.ExpectedCurrentReleaseID == nil || desired.Activate.ExpectedCurrentPayloadDigest == nil {
			return nil, errors.New("post-activation verification failed and rollback was not authorized")
		}
		rollback := activateDesired{
			ReleaseID: *desired.Activate.ExpectedCurrentReleaseID, PayloadDigest: *desired.Activate.ExpectedCurrentPayloadDigest,
			ExpectedCurrentReleaseID: &desired.Activate.ReleaseID, ExpectedCurrentPayloadDigest: &desired.Activate.PayloadDigest,
		}
		if _, err := activateRelease(stateDir, target, targetDigest, mustJSON(rollback)); err != nil {
			return nil, errors.New("post-activation verification failed and conditional rollback failed")
		}
		state = "rolled-back"
	}
	return map[string]any{"state": state, "staged": staged, "activated": activated, "verification": verification}, nil
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

func decodeDesired(raw json.RawMessage, destination any) error {
	if err := decodeStrict(raw, destination); err != nil {
		return fmt.Errorf("desired state is invalid: %w", err)
	}
	return nil
}

func reconcileReleaseDirectory(target TargetConfig, raw json.RawMessage) (any, error) {
	var desired releaseDirectoryDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	if desired.Root != target.CanonicalRoot || desired.RetainReleases < target.RetainReleases {
		return nil, errors.New("release directory differs from the enrolled target contract")
	}
	if err := requireNoSymlinks(target.AllowedRootPrefix, false); err != nil {
		return nil, err
	}
	if err := requireNoSymlinks(target.CanonicalRoot, true); err != nil {
		return nil, err
	}
	for _, directory := range []string{target.CanonicalRoot, filepath.Join(target.CanonicalRoot, "releases"), filepath.Join(target.CanonicalRoot, "incoming")} {
		if err := os.MkdirAll(directory, 0755); err != nil {
			return nil, err
		}
		if err := os.Chown(directory, int(target.DeployUID), int(target.DeployGID)); err != nil {
			return nil, err
		}
		if directory != filepath.Join(target.CanonicalRoot, "incoming") {
			// nginx serves through current -> releases/<id>/site. An existing
			// private root must be traversable after reconciliation too.
			if err := os.Chmod(directory, 0755); err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"root": target.CanonicalRoot, "retainReleases": desired.RetainReleases, "layout": "ready"}, nil
}

func nginxPath(target TargetConfig) string {
	return filepath.Join(target.NginxAvailableDir, target.Hostname)
}

func reconcileIngress(target TargetConfig, raw json.RawMessage, tls bool) (any, error) {
	content, err := renderIngress(target, raw, tls)
	if err != nil {
		return nil, err
	}
	filename := nginxPath(target)
	if existing, readErr := os.ReadFile(filename); readErr == nil && !bytes.HasPrefix(existing, []byte("# managed-by: psm-host-helper/v1\n")) {
		return nil, errors.New("refusing to replace an nginx file not owned by PSM")
	}
	if err := writeAtomic(filename, content, 0644, 0, 0); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(target.NginxEnabledDir, 0755); err != nil {
		return nil, err
	}
	enabled := filepath.Join(target.NginxEnabledDir, target.Hostname)
	if info, statErr := os.Lstat(enabled); statErr == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return nil, errors.New("enabled nginx entry is not a symlink")
		}
		link, _ := os.Readlink(enabled)
		if link != filename {
			return nil, errors.New("enabled nginx entry points elsewhere")
		}
	} else if errors.Is(statErr, os.ErrNotExist) {
		if err := os.Symlink(filename, enabled); err != nil {
			return nil, err
		}
	} else if statErr != nil {
		return nil, statErr
	}
	digest := sha256.Sum256(content)
	return map[string]any{"hostname": target.Hostname, "mode": map[bool]string{true: "tls", false: "http"}[tls], "configDigest": "sha256:" + hex.EncodeToString(digest[:])}, nil
}

func reconcileCertificate(target TargetConfig, raw json.RawMessage) (any, error) {
	var desired certificateDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	if desired.Hostname != target.Hostname || desired.Renewal != "automatic" {
		return nil, errors.New("certificate differs from the enrolled target contract")
	}
	if err := os.MkdirAll(target.AcmeWebroot, 0755); err != nil {
		return nil, err
	}
	if _, err := commandResult("certbot", "certonly", "--webroot", "-w", target.AcmeWebroot, "-d", target.Hostname,
		"--non-interactive", "--agree-tos", "--keep-until-expiring", "--email", target.CertbotEmail); err != nil {
		return nil, err
	}
	return observeCertificate(target)
}

func commandResult(name string, args ...string) (any, error) {
	command := exec.Command(name, args...)
	command.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	output := &boundedWriter{maximum: 64 * 1024}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	detail := strings.TrimSpace(string(output.value))
	if len(detail) > 1_000 {
		detail = detail[len(detail)-1_000:]
	}
	if err != nil {
		return nil, fmt.Errorf("%s failed: %s", name, detail)
	}
	return map[string]any{"command": name, "result": detail}, nil
}

type boundedWriter struct {
	value   []byte
	maximum int
}

func (writer *boundedWriter) Write(value []byte) (int, error) {
	original := len(value)
	remaining := writer.maximum - len(writer.value)
	if remaining > 0 {
		if len(value) > remaining {
			value = value[:remaining]
		}
		writer.value = append(writer.value, value...)
	}
	return original, nil
}

func observeCertificate(target TargetConfig) (any, error) {
	raw, err := os.ReadFile(filepath.Join("/etc/letsencrypt/live", target.Hostname, "fullchain.pem"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{"state": "create", "hostname": target.Hostname}, nil
		}
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("certificate file is invalid")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}
	if err := certificate.VerifyHostname(target.Hostname); err != nil {
		return map[string]any{"state": "conflict", "hostname": target.Hostname, "notAfter": certificate.NotAfter.UTC().Format(time.RFC3339)}, nil
	}
	state := "in-sync"
	if time.Until(certificate.NotAfter) < 21*24*time.Hour {
		state = "update"
	}
	return map[string]any{"state": state, "hostname": target.Hostname, "notAfter": certificate.NotAfter.UTC().Format(time.RFC3339), "serial": certificate.SerialNumber.String()}, nil
}

func observeResource(target TargetConfig, raw json.RawMessage) (any, error) {
	// Service kinds carry different fields; route them before the strict static decode.
	var kind struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &kind); err == nil {
		switch kind.Kind {
		case "systemd-node-service@1", "service-secrets@1":
			return observeServiceResource(target, raw)
		case "nginx-node-proxy@1":
			return observeProxy(target, raw)
		}
	}
	var desired observeDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	switch desired.Kind {
	case "host-release-directory@1":
		if desired.Root != target.CanonicalRoot || desired.RetainReleases < target.RetainReleases {
			return nil, errors.New("release directory differs from the target contract")
		}
		publicPermissionsDrifted := false
		for _, name := range []string{"", "releases", "incoming"} {
			info, err := os.Stat(filepath.Join(target.CanonicalRoot, name))
			if errors.Is(err, os.ErrNotExist) {
				return map[string]any{"state": "create", "root": target.CanonicalRoot}, nil
			}
			if err != nil || !info.IsDir() {
				return map[string]any{"state": "conflict", "root": target.CanonicalRoot}, nil
			}
			if name != "incoming" && info.Mode().Perm() != 0755 {
				publicPermissionsDrifted = true
			}
		}
		if publicPermissionsDrifted {
			return map[string]any{"state": "update", "root": target.CanonicalRoot, "detail": "public release directories need nginx traversal"}, nil
		}
		return map[string]any{"state": "in-sync", "root": target.CanonicalRoot, "retainReleases": desired.RetainReleases}, nil
	case "nginx-static-site@1":
		if err := requireStatic(target); err != nil {
			return nil, err
		}
		ingress := ingressDesired{Hostname: desired.Hostname, DocumentRoot: desired.DocumentRoot, SPAFallback: desired.SPAFallback, DenyPrefixes: desired.DenyPrefixes, CachePolicy: desired.CachePolicy, SecurityHeaders: desired.SecurityHeaders}
		tls := true
		if desired.TLS != nil {
			tls = *desired.TLS
		}
		expected, err := renderNginx(target, ingress, tls)
		if err != nil {
			return nil, err
		}
		actual, err := os.ReadFile(nginxPath(target))
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{"state": "create", "hostname": target.Hostname}, nil
		}
		if err != nil {
			return nil, err
		}
		if !bytes.HasPrefix(actual, []byte("# managed-by: psm-host-helper/v1\n")) {
			return map[string]any{"state": "conflict", "hostname": target.Hostname, "owned": false}, nil
		}
		state := "in-sync"
		if !bytes.Equal(actual, expected) {
			state = "update"
		}
		digest := sha256.Sum256(actual)
		return map[string]any{"state": state, "hostname": target.Hostname, "owned": true, "configDigest": "sha256:" + hex.EncodeToString(digest[:])}, nil
	case "letsencrypt-certificate@1":
		if desired.Hostname != target.Hostname || desired.Renewal != "automatic" {
			return nil, errors.New("certificate differs from the target contract")
		}
		return observeCertificate(target)
	default:
		return nil, errors.New("resource kind is unsupported by the host helper")
	}
}

// pm2List runs `pm2 jlist` as the target's PM2 user; tests replace it.
var pm2List = func(target TargetConfig) ([]byte, error) {
	command := exec.Command("runuser", "-u", target.PM2User, "--", "env", "PM2_HOME="+target.PM2Home, "pm2", "jlist")
	command.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"}
	return command.Output()
}

func pm2Snapshot(target TargetConfig) (any, error) {
	raw, err := pm2List(target)
	if err != nil {
		var exit *exec.ExitError
		// A host without PM2 runs no PM2 processes: that empty set is the invariant
		// (env exits 127 when the command does not exist).
		if errors.As(err, &exit) && exit.ExitCode() == 127 {
			raw, err = []byte("[]"), nil
		}
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			detail := strings.TrimSpace(string(exit.Stderr))
			if len(detail) > 300 {
				detail = detail[len(detail)-300:]
			}
			if detail != "" {
				return nil, fmt.Errorf("pm2 snapshot failed: %s", detail)
			}
		}
		return nil, fmt.Errorf("pm2 snapshot failed: %w", err)
	}
	if len(raw) > 2*1024*1024 {
		return nil, errors.New("pm2 response is too large")
	}
	var processes []map[string]any
	if err := json.Unmarshal(raw, &processes); err != nil {
		return nil, errors.New("pm2 response is invalid")
	}
	type normalized struct{ Name, Status, Script string }
	items := []normalized{}
	for _, process := range processes {
		environment, _ := process["pm2_env"].(map[string]any)
		name, _ := process["name"].(string)
		status, _ := environment["status"].(string)
		script, _ := environment["pm_exec_path"].(string)
		items = append(items, normalized{Name: name, Status: status, Script: script})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Name < items[j].Name || (items[i].Name == items[j].Name && items[i].Script < items[j].Script)
	})
	canonical, _ := json.Marshal(items)
	digest := sha256.Sum256(canonical)
	return map[string]any{"digest": "sha256:" + hex.EncodeToString(digest[:]), "processes": items}, nil
}

func comparePM2(target TargetConfig, raw json.RawMessage) (any, error) {
	var desired pm2CompareDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	if !digestPattern.MatchString(desired.ExpectedDigest) {
		return nil, errors.New("expected PM2 digest is invalid")
	}
	result, err := pm2Snapshot(target)
	if err != nil {
		return nil, err
	}
	actual := result.(map[string]any)["digest"]
	if actual != desired.ExpectedDigest {
		return nil, errors.New("PM2 process set changed during static deployment")
	}
	return result, nil
}

type proxyObserveDesired struct {
	Kind            string `json:"kind"`
	Hostname        string `json:"hostname"`
	SecurityHeaders string `json:"securityHeaders"`
	MaxBodyMB       int    `json:"maxBodyMb"`
	TLS             *bool  `json:"tls,omitempty"`
}

func observeProxy(target TargetConfig, raw json.RawMessage) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
	var desired proxyObserveDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	tls := true
	if desired.TLS != nil {
		tls = *desired.TLS
	}
	expected, err := renderProxy(target, proxyIngressDesired{Hostname: desired.Hostname, SecurityHeaders: desired.SecurityHeaders, MaxBodyMB: desired.MaxBodyMB}, tls)
	if err != nil {
		return nil, err
	}
	actual, err := os.ReadFile(nginxPath(target))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{"state": "create", "hostname": target.Hostname}, nil
	}
	if err != nil {
		return nil, err
	}
	if !bytes.HasPrefix(actual, []byte(managedHeader)) {
		return map[string]any{"state": "conflict", "hostname": target.Hostname, "owned": false}, nil
	}
	state := "in-sync"
	if !bytes.Equal(actual, expected) {
		state = "update"
	}
	digest := sha256.Sum256(actual)
	return map[string]any{"state": state, "hostname": target.Hostname, "owned": true, "configDigest": "sha256:" + hex.EncodeToString(digest[:])}, nil
}
