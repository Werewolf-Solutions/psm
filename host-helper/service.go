package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"text/template"
	"time"
)

// ServiceConfig is the root-owned part of a target contract that turns it into a
// supervised Node service. The repository can choose none of it: the unit name,
// user, port, entry point and limits are fixed at enrollment.
type ServiceConfig struct {
	UnitName              string `json:"unitName"`
	User                  string `json:"user"`
	UID                   uint32 `json:"uid"`
	GID                   uint32 `json:"gid"`
	Port                  int    `json:"port"`
	MemoryMaxMB           int    `json:"memoryMaxMb"`
	Entry                 string `json:"entry"`
	HealthPath            string `json:"healthPath"`
	StartupTimeoutSeconds int    `json:"startupTimeoutSeconds"`
	SystemdDir            string `json:"systemdDir"`
	ConfigDir             string `json:"configDir"`
	// AlternatePort enrolls a second loopback port. With it a release starts in
	// the idle slot and takes traffic only after passing the health gate.
	AlternatePort int `json:"alternatePort,omitempty"`
	DrainSeconds  int `json:"drainSeconds,omitempty"`
}

const (
	servicePortMinimum = 41000
	servicePortMaximum = 41999
	managedHeader      = "# managed-by: psm-host-helper/v1\n"
)

var (
	unitNamePattern   = regexp.MustCompile(`^psm-svc-[a-z0-9][a-z0-9-]{0,58}$`)
	userNamePattern   = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	entryPattern      = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)
	healthPathPattern = regexp.MustCompile(`^/[A-Za-z0-9._~/-]{0,200}$`)
	envNamePattern    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,99}$`)
	saltPattern       = regexp.MustCompile(`^[0-9a-f]{32,128}$`)
	upstreamPattern   = regexp.MustCompile(`(?m)^server 127\.0\.0\.1:(\d{5});$`)
	// Runner commands, replaced in tests.
	runCommand = commandResult
	lookupUser = user.Lookup
	drainWait  = time.Sleep
)

func (service *ServiceConfig) normalize() {
	if service.SystemdDir == "" {
		service.SystemdDir = "/etc/systemd/system"
	}
	if service.ConfigDir == "" {
		service.ConfigDir = "/etc/psm-deploy/services"
	}
}

func (service *ServiceConfig) validate(target TargetConfig) error {
	service.normalize()
	if !unitNamePattern.MatchString(service.UnitName) {
		return errors.New("unitName must be psm-svc-<lowercase name>")
	}
	if !userNamePattern.MatchString(service.User) || service.UID == 0 || service.GID == 0 {
		return errors.New("user must be a named non-root account")
	}
	if service.UID == target.DeployUID || slices.Contains(target.InfrastructureUIDs, service.UID) || slices.Contains(target.ReleaseUIDs, service.UID) {
		return errors.New("the service user must not be a deploy, infrastructure or release account")
	}
	if service.Port < servicePortMinimum || service.Port > servicePortMaximum {
		return fmt.Errorf("port must be in %d-%d", servicePortMinimum, servicePortMaximum)
	}
	if service.MemoryMaxMB < 64 || service.MemoryMaxMB > 4096 {
		return errors.New("memoryMaxMb must be between 64 and 4096")
	}
	if !entryPattern.MatchString(service.Entry) {
		return errors.New("entry is invalid")
	}
	if _, err := canonicalRelativePath(service.Entry); err != nil {
		return fmt.Errorf("entry: %w", err)
	}
	if !healthPathPattern.MatchString(service.HealthPath) {
		return errors.New("healthPath is invalid")
	}
	if service.StartupTimeoutSeconds < 5 || service.StartupTimeoutSeconds > 300 {
		return errors.New("startupTimeoutSeconds must be between 5 and 300")
	}
	if service.AlternatePort != 0 && (service.AlternatePort < servicePortMinimum || service.AlternatePort > servicePortMaximum || service.AlternatePort == service.Port) {
		return fmt.Errorf("alternatePort must be another port in %d-%d", servicePortMinimum, servicePortMaximum)
	}
	if service.DrainSeconds < 0 || service.DrainSeconds > 60 || (service.DrainSeconds != 0 && service.AlternatePort == 0) {
		return errors.New("drainSeconds must be between 0 and 60 and needs alternatePort")
	}
	for label, value := range map[string]string{"systemdDir": service.SystemdDir, "configDir": service.ConfigDir} {
		if _, err := cleanAbsolute(value); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	return nil
}

// payloadRoot is the directory inside each release that `current` points to.
func payloadRoot(target TargetConfig) string {
	if target.Service != nil {
		return "bundle"
	}
	return "site"
}

func targetAlgorithm(target TargetConfig) string {
	if target.Service != nil {
		return serviceAlgorithm
	}
	return payloadAlgorithm
}

func serviceFiles(target TargetConfig) (unit, config, secrets string) {
	digest := sha256.Sum256([]byte(target.TargetID))
	directory := filepath.Join(target.Service.ConfigDir, hex.EncodeToString(digest[:16]))
	return filepath.Join(target.Service.SystemdDir, target.Service.UnitName+".service"),
		filepath.Join(directory, "config.env"), filepath.Join(directory, "secrets.env")
}

// serviceSlot is one supervised instance. A contract without an alternate port
// has only the primary slot and is restarted in place.
type serviceSlot struct {
	Unit string
	Port int
}

func serviceSlots(target TargetConfig) []serviceSlot {
	slots := []serviceSlot{{target.Service.UnitName, target.Service.Port}}
	if target.Service.AlternatePort != 0 {
		slots = append(slots, serviceSlot{target.Service.UnitName + "-alt", target.Service.AlternatePort})
	}
	return slots
}

func slotUnitFile(target TargetConfig, slot serviceSlot) string {
	return filepath.Join(target.Service.SystemdDir, slot.Unit+".service")
}

// upstreamFile names the slot nginx forwards to. It is the only record of which
// slot is live, so nginx and the helper cannot disagree.
func upstreamFile(target TargetConfig) string {
	_, config, _ := serviceFiles(target)
	return filepath.Join(filepath.Dir(config), "upstream.conf")
}

func renderUpstream(port int) []byte {
	return []byte(fmt.Sprintf("%sserver 127.0.0.1:%d;\n", managedHeader, port))
}

// liveSlot returns the slot taking traffic and, for a switching contract, the
// idle one. A missing upstream file means the primary has never been replaced.
func liveSlot(target TargetConfig) (live serviceSlot, idle *serviceSlot, err error) {
	slots := serviceSlots(target)
	if len(slots) == 1 {
		return slots[0], nil, nil
	}
	raw, err := os.ReadFile(upstreamFile(target))
	if errors.Is(err, os.ErrNotExist) {
		return slots[0], &slots[1], nil
	}
	if err != nil {
		return serviceSlot{}, nil, err
	}
	match := upstreamPattern.FindSubmatch(raw)
	if !bytes.HasPrefix(raw, []byte(managedHeader)) || match == nil {
		return serviceSlot{}, nil, errors.New("the service upstream file is not one the helper wrote")
	}
	switch string(match[1]) {
	case strconv.Itoa(slots[0].Port):
		return slots[0], &slots[1], nil
	case strconv.Itoa(slots[1].Port):
		return slots[1], &slots[0], nil
	}
	return serviceSlot{}, nil, errors.New("the service upstream file names a port outside the target contract")
}

func stateDirectory(target TargetConfig) string {
	return filepath.Join(target.CanonicalRoot, "state")
}

// reservedEnvironment names the variables the unit owns or that would change how
// Node or the dynamic loader behave; neither config nor secrets may set them.
func reservedEnvironment(name string) bool {
	switch name {
	case "HOST", "PORT", "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "NODE_ENV_FILE":
		return true
	}
	if strings.HasPrefix(name, "NODE_") && name != "NODE_ENV" {
		return true
	}
	for _, prefix := range []string{"LD_", "PSM_", "SYSTEMD_", "INVOCATION_", "NOTIFY_", "LISTEN_", "CREDENTIALS_"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func validateEnvironment(values map[string]string) error {
	if len(values) > 64 {
		return errors.New("too many environment variables")
	}
	for name, value := range values {
		if !envNamePattern.MatchString(name) || reservedEnvironment(name) {
			return fmt.Errorf("environment name %q is invalid or reserved", name)
		}
		if len(value) > 4096 {
			return fmt.Errorf("value of %s is too long", name)
		}
		for _, character := range value {
			if character < 0x20 || character == 0x7f {
				return fmt.Errorf("value of %s contains a control character", name)
			}
		}
	}
	return nil
}

// renderEnvironmentFile writes KEY="value" lines in systemd's EnvironmentFile
// syntax, sorted, with backslash and quote escaped. systemd does not expand
// variables in these files.
func renderEnvironmentFile(values map[string]string) []byte {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	var output bytes.Buffer
	output.WriteString(managedHeader)
	for _, name := range names {
		escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(values[name])
		fmt.Fprintf(&output, "%s=\"%s\"\n", name, escaped)
	}
	return output.Bytes()
}

// environmentNames reads the names (never the values) of a managed environment file.
func environmentNames(filename string) (map[string]bool, error) {
	raw, err := os.ReadFile(filename)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]bool{}, nil
	}
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if name, _, ok := strings.Cut(line, "="); ok {
			names[name] = true
		}
	}
	return names, scanner.Err()
}

// environmentValues parses a file this helper wrote; it accepts only its own syntax.
func environmentValues(filename string) (map[string]string, error) {
	raw, err := os.ReadFile(filename)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 8192), 16384)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, quoted, ok := strings.Cut(line, "=")
		if !ok || len(quoted) < 2 || quoted[0] != '"' || quoted[len(quoted)-1] != '"' {
			return nil, errors.New("environment file was not written by the helper")
		}
		values[name] = strings.NewReplacer(`\\`, `\`, `\"`, `"`).Replace(quoted[1 : len(quoted)-1])
	}
	return values, scanner.Err()
}

const unitTemplate = `# managed-by: psm-host-helper/v1
# target: {{.TargetID}}
[Unit]
Description=PSM service {{.TargetID}}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User={{.User}}
Group={{.GID}}
WorkingDirectory={{.Root}}/current/app
ExecStart={{.Root}}/current/runtime/bin/node {{.Entry}}
Environment=HOST=127.0.0.1
Environment=PORT={{.Port}}
EnvironmentFile={{.ConfigFile}}
EnvironmentFile=-{{.SecretsFile}}
Restart=on-failure
RestartSec=2
MemoryMax={{.MemoryMaxMB}}M
UMask=0027
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths={{.State}}

[Install]
WantedBy=multi-user.target
`

func renderUnit(target TargetConfig, slot serviceSlot) ([]byte, error) {
	service := target.Service
	_, config, secrets := serviceFiles(target)
	view := map[string]any{
		"TargetID": target.TargetID, "User": service.User, "GID": service.GID, "Root": target.CanonicalRoot,
		"Entry": service.Entry, "Port": slot.Port, "ConfigFile": config, "SecretsFile": secrets,
		"MemoryMaxMB": service.MemoryMaxMB, "State": stateDirectory(target),
	}
	parsed, err := template.New("unit").Parse(unitTemplate)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := parsed.Execute(&output, view); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// serviceDesired is what the manifest declares; every field but Config must equal
// the enrolled contract, so a manifest can describe the service but not widen it.
type serviceDesired struct {
	Entry                 string            `json:"entry"`
	HealthPath            string            `json:"healthPath"`
	StartupTimeoutSeconds int               `json:"startupTimeoutSeconds"`
	MemoryMaxMB           int               `json:"memoryMaxMb"`
	Config                map[string]string `json:"config"`
	Switching             string            `json:"switching,omitempty"`
	DrainSeconds          int               `json:"drainSeconds,omitempty"`
}

func (desired serviceDesired) matches(service *ServiceConfig) error {
	if desired.Entry != service.Entry || desired.HealthPath != service.HealthPath ||
		desired.StartupTimeoutSeconds != service.StartupTimeoutSeconds || desired.MemoryMaxMB != service.MemoryMaxMB {
		return errors.New("service entry, health path, startup timeout or memory limit differs from the enrolled target contract")
	}
	if desired.Switching != "" && desired.Switching != "health-checked" {
		return errors.New("service switching mode is unsupported")
	}
	if (desired.Switching == "health-checked") != (service.AlternatePort != 0) || desired.DrainSeconds != service.DrainSeconds {
		return errors.New("service switching differs from the enrolled target contract; enroll the target again to change it")
	}
	return nil
}

type serviceSecretsDesired struct {
	Values map[string]string `json:"values"`
}

func requireService(target TargetConfig) error {
	if target.Service == nil {
		return errors.New("target is not enrolled as a service")
	}
	return nil
}

func requireStatic(target TargetConfig) error {
	if target.Service != nil {
		return errors.New("target is enrolled as a service, not a static site")
	}
	return nil
}

// writeManaged replaces a file only if it is absent or was written by this helper.
func writeManaged(filename string, content []byte, mode os.FileMode) (bool, error) {
	existing, err := os.ReadFile(filename)
	if err == nil {
		if !bytes.HasPrefix(existing, []byte(managedHeader)) {
			return false, fmt.Errorf("refusing to replace %s, which PSM does not own", filename)
		}
		if bytes.Equal(existing, content) {
			return false, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return false, err
	}
	return true, writeAtomic(filename, content, mode, 0, 0)
}

func checkServiceUser(service *ServiceConfig) error {
	account, err := lookupUser(service.User)
	if err != nil {
		return fmt.Errorf("service user %s does not exist; create it during enrollment", service.User)
	}
	if account.Uid != strconv.FormatUint(uint64(service.UID), 10) || account.Gid != strconv.FormatUint(uint64(service.GID), 10) {
		return fmt.Errorf("service user %s has different IDs than the target contract", service.User)
	}
	return nil
}

// reconcileService writes the unit and the non-secret configuration, prepares the
// state directory, and restarts a running release when either changed.
func reconcileService(target TargetConfig, raw json.RawMessage) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
	var desired serviceDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	if err := desired.matches(target.Service); err != nil {
		return nil, err
	}
	if desired.Config == nil {
		desired.Config = map[string]string{}
	}
	if err := validateEnvironment(desired.Config); err != nil {
		return nil, err
	}
	_, configFile, secretsFile := serviceFiles(target)
	secretNames, err := environmentNames(secretsFile)
	if err != nil {
		return nil, err
	}
	for name := range desired.Config {
		if secretNames[name] {
			return nil, fmt.Errorf("%s is already a secret; a name is either config or secret", name)
		}
	}
	if err := checkServiceUser(target.Service); err != nil {
		return nil, err
	}
	state := stateDirectory(target)
	if err := requireNoSymlinks(target.CanonicalRoot, false); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(state, 0750); err != nil {
		return nil, err
	}
	if err := chownPath(state, int(target.Service.UID), int(target.Service.GID)); err != nil {
		return nil, err
	}
	if err := os.Chmod(state, 0750); err != nil {
		return nil, err
	}
	configChanged, err := writeManaged(configFile, renderEnvironmentFile(desired.Config), 0600)
	if err != nil {
		return nil, err
	}
	live, idle, err := liveSlot(target)
	if err != nil {
		return nil, err
	}
	unitChanged := false
	var unit []byte
	for index, slot := range serviceSlots(target) {
		rendered, err := renderUnit(target, slot)
		if err != nil {
			return nil, err
		}
		changed, err := writeManaged(slotUnitFile(target, slot), rendered, 0644)
		if err != nil {
			return nil, err
		}
		unitChanged = unitChanged || changed
		if index == 0 {
			unit = rendered
		}
	}
	if idle != nil {
		// Created once; afterwards only a switch moves it.
		if _, err := os.Stat(upstreamFile(target)); errors.Is(err, os.ErrNotExist) {
			if _, err := writeManaged(upstreamFile(target), renderUpstream(live.Port), 0644); err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		}
	}
	if unitChanged {
		if _, err := runCommand("systemctl", "daemon-reload"); err != nil {
			return nil, err
		}
	}
	if _, err := runCommand("systemctl", "enable", live.Unit); err != nil {
		return nil, err
	}
	restarted := false
	if (unitChanged || configChanged) && hasActiveRelease(target) {
		if err := restartHealthy(target); err != nil {
			return nil, err
		}
		restarted = true
	}
	digest := sha256.Sum256(unit)
	return map[string]any{"unit": target.Service.UnitName, "unitDigest": "sha256:" + hex.EncodeToString(digest[:]),
		"configNames": sortedNames(desired.Config), "changed": unitChanged || configChanged, "restarted": restarted}, nil
}

func reconcileServiceSecrets(target TargetConfig, raw json.RawMessage) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
	var desired serviceSecretsDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	if desired.Values == nil {
		desired.Values = map[string]string{}
	}
	if err := validateEnvironment(desired.Values); err != nil {
		return nil, err
	}
	_, configFile, secretsFile := serviceFiles(target)
	configNames, err := environmentNames(configFile)
	if err != nil {
		return nil, err
	}
	for name := range desired.Values {
		if configNames[name] {
			return nil, fmt.Errorf("%s is already config; a name is either config or secret", name)
		}
	}
	changed, err := writeManaged(secretsFile, renderEnvironmentFile(desired.Values), 0600)
	if err != nil {
		return nil, err
	}
	restarted := false
	if changed && hasActiveRelease(target) {
		if err := restartHealthy(target); err != nil {
			return nil, err
		}
		restarted = true
	}
	// Names only: values never leave the host in a response.
	return map[string]any{"names": sortedNames(desired.Values), "changed": changed, "restarted": restarted}, nil
}

func sortedNames(values map[string]string) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type serviceObserveDesired struct {
	Kind                  string            `json:"kind"`
	Entry                 string            `json:"entry,omitempty"`
	HealthPath            string            `json:"healthPath,omitempty"`
	StartupTimeoutSeconds int               `json:"startupTimeoutSeconds,omitempty"`
	MemoryMaxMB           int               `json:"memoryMaxMb,omitempty"`
	Config                map[string]string `json:"config,omitempty"`
	Switching             string            `json:"switching,omitempty"`
	DrainSeconds          int               `json:"drainSeconds,omitempty"`
	Names                 []string          `json:"names,omitempty"`
	Salt                  string            `json:"salt,omitempty"`
}

// observeServiceResource compares the rendered unit and config with the host,
// or reports secret fingerprints keyed by a caller-chosen salt (never values).
func observeServiceResource(target TargetConfig, raw json.RawMessage) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
	var desired serviceObserveDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	_, configFile, secretsFile := serviceFiles(target)
	switch desired.Kind {
	case "systemd-node-service@1":
		declared := serviceDesired{Entry: desired.Entry, HealthPath: desired.HealthPath, StartupTimeoutSeconds: desired.StartupTimeoutSeconds, MemoryMaxMB: desired.MemoryMaxMB,
			Switching: desired.Switching, DrainSeconds: desired.DrainSeconds}
		if err := declared.matches(target.Service); err != nil {
			return map[string]any{"state": "conflict", "unit": target.Service.UnitName, "detail": err.Error()}, nil
		}
		if desired.Config == nil {
			desired.Config = map[string]string{}
		}
		if err := validateEnvironment(desired.Config); err != nil {
			return nil, err
		}
		type managedFile struct {
			file    string
			content []byte
		}
		files := []managedFile{{configFile, renderEnvironmentFile(desired.Config)}}
		for _, slot := range serviceSlots(target) {
			unit, err := renderUnit(target, slot)
			if err != nil {
				return nil, err
			}
			files = append(files, managedFile{slotUnitFile(target, slot), unit})
		}
		state := "in-sync"
		for _, expected := range files {
			actual, err := os.ReadFile(expected.file)
			if errors.Is(err, os.ErrNotExist) {
				state = "create"
				break
			}
			if err != nil {
				return nil, err
			}
			if !bytes.HasPrefix(actual, []byte(managedHeader)) {
				return map[string]any{"state": "conflict", "unit": target.Service.UnitName, "owned": false}, nil
			}
			if !bytes.Equal(actual, expected.content) {
				state = "update"
			}
		}
		if state == "in-sync" {
			if info, err := os.Stat(stateDirectory(target)); err != nil || !info.IsDir() {
				state = "update"
			}
		}
		if state == "in-sync" && target.Service.AlternatePort != 0 {
			if _, _, err := liveSlot(target); err != nil {
				return map[string]any{"state": "conflict", "unit": target.Service.UnitName, "detail": err.Error()}, nil
			}
			if _, err := os.Stat(upstreamFile(target)); err != nil {
				state = "update"
			}
		}
		return map[string]any{"state": state, "unit": target.Service.UnitName, "owned": true}, nil
	case "service-secrets@1":
		if !saltPattern.MatchString(desired.Salt) || len(desired.Names) > 64 {
			return nil, errors.New("secret observation needs names and a hex salt")
		}
		values, err := environmentValues(secretsFile)
		if err != nil {
			return nil, err
		}
		salt, _ := hex.DecodeString(desired.Salt)
		fingerprints := map[string]any{}
		for _, name := range desired.Names {
			if !envNamePattern.MatchString(name) {
				return nil, fmt.Errorf("secret name %q is invalid", name)
			}
			value, ok := values[name]
			if !ok {
				fingerprints[name] = nil
				continue
			}
			mac := hmac.New(sha256.New, salt)
			mac.Write([]byte(value))
			fingerprints[name] = "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil))
		}
		extra := []string{}
		for name := range values {
			if !slices.Contains(desired.Names, name) {
				extra = append(extra, name)
			}
		}
		sort.Strings(extra)
		state := "in-sync"
		for _, fingerprint := range fingerprints {
			if fingerprint == nil {
				state = "create"
			}
		}
		if len(extra) > 0 && state == "in-sync" {
			state = "update"
		}
		return map[string]any{"state": state, "fingerprints": fingerprints, "undeclared": extra}, nil
	default:
		return nil, errors.New("resource kind is unsupported by the host helper")
	}
}

func hasActiveRelease(target TargetConfig) bool {
	current, err := activeRelease(target)
	return err == nil && current != nil
}

// restartHealthy puts the release `current` names into service. A switching
// contract starts it in the idle slot and moves traffic only once it is healthy;
// otherwise the unit restarts in place, with a gap.
func restartHealthy(target TargetConfig) error {
	live, idle, err := liveSlot(target)
	if err != nil {
		return err
	}
	if idle != nil && ingressUsesUpstream(target) {
		return switchHealthy(target, live, *idle)
	}
	if _, err := runCommand("systemctl", "restart", live.Unit); err != nil {
		return err
	}
	return waitHealthy(target, live)
}

// ingressUsesUpstream reports whether nginx already forwards through the
// upstream file. Until it does, moving the file would not move traffic.
func ingressUsesUpstream(target TargetConfig) bool {
	site, err := os.ReadFile(nginxPath(target))
	return err == nil && bytes.Contains(site, []byte("include "+upstreamFile(target)+";"))
}

// switchHealthy leaves the live slot untouched until the candidate has passed
// the health gate and nginx has accepted the new upstream.
func switchHealthy(target TargetConfig, live, candidate serviceSlot) error {
	if _, err := runCommand("systemctl", "restart", candidate.Unit); err != nil {
		return err
	}
	if err := waitHealthy(target, candidate); err != nil {
		_, _ = runCommand("systemctl", "stop", candidate.Unit)
		return err
	}
	if _, err := writeManaged(upstreamFile(target), renderUpstream(candidate.Port), 0644); err != nil {
		_, _ = runCommand("systemctl", "stop", candidate.Unit)
		return err
	}
	_, err := runCommand("nginx", "-t")
	if err == nil {
		_, err = runCommand("systemctl", "reload", "nginx")
	}
	if err != nil {
		_, _ = writeManaged(upstreamFile(target), renderUpstream(live.Port), 0644)
		_, _ = runCommand("systemctl", "stop", candidate.Unit)
		return fmt.Errorf("nginx did not accept the new upstream; the previous service keeps serving: %s", boundedError(err))
	}
	// From here the candidate serves. Boot must start it, not the slot it replaced.
	if _, err := runCommand("systemctl", "enable", candidate.Unit); err != nil {
		return err
	}
	if _, err := runCommand("systemctl", "disable", live.Unit); err != nil {
		return err
	}
	// nginx's old workers finish requests they already forwarded to the previous slot.
	drain := target.Service.DrainSeconds
	if drain == 0 {
		drain = 5
	}
	drainWait(time.Duration(drain) * time.Second)
	_, err = runCommand("systemctl", "stop", live.Unit)
	return err
}

var healthClient = &http.Client{
	Timeout:       3 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func waitHealthy(target TargetConfig, slot serviceSlot) error {
	service := target.Service
	url := fmt.Sprintf("http://127.0.0.1:%d%s", slot.Port, service.HealthPath)
	deadline := time.Now().Add(time.Duration(service.StartupTimeoutSeconds) * time.Second)
	last := "no answer"
	for {
		response, err := healthClient.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				if err := serviceListensOnLoopbackOnly(slot.Port); err != nil {
					return err
				}
				active, err := unitActive(slot.Unit)
				if err != nil {
					return err
				}
				if !active {
					return errors.New("the service answered but systemd does not report it active")
				}
				return nil
			}
			last = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("service did not become healthy within %ds (%s from %s)", service.StartupTimeoutSeconds, last, service.HealthPath)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func unitActive(unit string) (bool, error) {
	properties, err := unitProperties(unit)
	if err != nil {
		return false, err
	}
	return properties["ActiveState"] == "active", nil
}

func unitProperties(unit string) (map[string]string, error) {
	result, err := runCommand("systemctl", "show", unit, "--property=ActiveState,SubState,NRestarts,MemoryCurrent,MainPID")
	if err != nil {
		return nil, err
	}
	output, _ := result.(map[string]any)["result"].(string)
	properties := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		if name, value, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			properties[name] = value
		}
	}
	return properties, nil
}

var procNetFiles = []string{"/proc/net/tcp", "/proc/net/tcp6"}

// serviceListensOnLoopbackOnly reads the kernel's socket tables: the port must
// have a listener, and every listener on it must be bound to 127.0.0.1.
func serviceListensOnLoopbackOnly(port int) error {
	hexPort := fmt.Sprintf("%04X", port)
	found := false
	for _, filename := range procNetFiles {
		raw, err := os.ReadFile(filename)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		for _, line := range strings.Split(string(raw), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			address, localPort, ok := strings.Cut(fields[1], ":")
			if !ok || localPort != hexPort {
				continue
			}
			if address != "0100007F" {
				return fmt.Errorf("the service listens on a non-loopback address for port %d", port)
			}
			found = true
		}
	}
	if !found {
		return fmt.Errorf("nothing listens on 127.0.0.1:%d", port)
	}
	return nil
}

func observeService(target TargetConfig, targetDigest string) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
	observed, err := observeTarget(target, targetDigest)
	if err != nil {
		return nil, err
	}
	live, idle, err := liveSlot(target)
	if err != nil {
		return nil, err
	}
	properties, err := unitProperties(live.Unit)
	if err != nil {
		return nil, err
	}
	result := observed.(map[string]any)
	listening := serviceListensOnLoopbackOnly(live.Port)
	result["service"] = map[string]any{
		"unit": live.Unit, "port": live.Port, "switching": idle != nil && ingressUsesUpstream(target), "activeState": properties["ActiveState"], "subState": properties["SubState"],
		"restarts": properties["NRestarts"], "memoryBytes": properties["MemoryCurrent"],
		"memoryMaxBytes": int64(target.Service.MemoryMaxMB) * 1024 * 1024,
		"loopbackOnly":   listening == nil, "listenDetail": errorText(listening),
	}
	return result, nil
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// activateServiceRelease switches `current` and restarts the unit; if the new
// release does not become healthy it is reported as an error and left for the
// caller to roll back under the same lock.
func activateServiceRelease(stateDir string, target TargetConfig, targetDigest string, raw json.RawMessage) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
	activated, err := activateRelease(stateDir, target, targetDigest, raw)
	if err != nil {
		return nil, err
	}
	if err := restartHealthy(target); err != nil {
		return activated, err
	}
	return activated, nil
}

func deployServiceRelease(stateDir string, target TargetConfig, targetDigest string, request Request, archive io.Reader) (any, error) {
	if err := requireService(target); err != nil {
		return nil, err
	}
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
	stageRequest.Desired = mustJSON(desired.Stage)
	staged, err := stageRelease(target, targetDigest, stageRequest, archive)
	if err != nil {
		return nil, err
	}
	activated, activationErr := activateServiceRelease(stateDir, target, targetDigest, mustJSON(desired.Activate))
	if activationErr != nil && activated == nil {
		return nil, activationErr
	}
	verification := []map[string]any{{"id": "health", "state": "passed", "code": "ok"}}
	verificationFailed := false
	failureDetail := ""
	if activationErr != nil {
		verification[0] = map[string]any{"id": "health", "state": "failed", "code": "unhealthy", "detail": boundedError(activationErr)}
		verificationFailed = true
		failureDetail = "health: " + boundedError(activationErr)
	}
	if _, err := comparePM2(target, mustJSON(pm2CompareDesired{ExpectedDigest: desired.ExpectedPM2Digest})); err != nil {
		verification = append(verification, map[string]any{"id": "pm2-unchanged", "state": "failed", "code": "pm2-changed"})
		verificationFailed = true
		if failureDetail == "" {
			failureDetail = "PM2 state changed"
		}
	}
	if !verificationFailed {
		for _, probe := range desired.Probes {
			_, probeErr := runExecutorProbe(target, probe)
			state, code := "passed", "ok"
			if probeErr != nil {
				state, code, verificationFailed = "failed", "probe-failed", true
				if failureDetail == "" {
					failureDetail = probe.ID + ": " + boundedError(probeErr)
				}
			}
			verification = append(verification, map[string]any{"id": probe.ID, "state": state, "code": code})
		}
	}
	state := "activated"
	if verificationFailed {
		if !desired.RollbackAllowed || desired.Activate.ExpectedCurrentReleaseID == nil || desired.Activate.ExpectedCurrentPayloadDigest == nil {
			live, idle, slotErr := liveSlot(target)
			if activationErr != nil && slotErr == nil && idle != nil && ingressUsesUpstream(target) {
				// The candidate failed its gate before any switch: the previous slot never stopped.
				return map[string]any{"state": "failed", "staged": staged, "activated": activated, "verification": verification},
					fmt.Errorf("the new release failed its health gate (%s) and received no traffic; rollback was not authorized, so the previous release keeps serving while current names the failed one", failureDetail)
			}
			if slotErr == nil {
				_, _ = runCommand("systemctl", "stop", live.Unit)
			}
			return map[string]any{"state": "failed", "staged": staged, "activated": activated, "verification": verification},
				fmt.Errorf("post-activation verification failed (%s) and rollback was not authorized; the service was stopped", failureDetail)
		}
		rollback := activateDesired{
			ReleaseID: *desired.Activate.ExpectedCurrentReleaseID, PayloadDigest: *desired.Activate.ExpectedCurrentPayloadDigest,
			ExpectedCurrentReleaseID: &desired.Activate.ReleaseID, ExpectedCurrentPayloadDigest: &desired.Activate.PayloadDigest,
		}
		if _, err := activateServiceRelease(stateDir, target, targetDigest, mustJSON(rollback)); err != nil {
			return nil, fmt.Errorf("post-activation verification failed and rollback failed: %s", boundedError(err))
		}
		state = "rolled-back"
	}
	return map[string]any{"state": state, "staged": staged, "activated": activated, "verification": verification}, nil
}
