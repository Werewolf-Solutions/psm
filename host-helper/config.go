package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const targetSchema = "psm.werewolf.solutions/host-target/v1"

var (
	idPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	hostnamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
)

type TargetConfig struct {
	Schema             string   `json:"schema"`
	Revision           string   `json:"revision"`
	TargetID           string   `json:"targetId"`
	ProjectID          string   `json:"projectId"`
	EnvironmentID      string   `json:"environmentId"`
	UnitID             string   `json:"unitId"`
	CanonicalRoot      string   `json:"canonicalRoot"`
	AllowedRootPrefix  string   `json:"allowedRootPrefix"`
	Hostname           string   `json:"hostname"`
	DeployUID          uint32   `json:"deployUid"`
	DeployGID          uint32   `json:"deployGid"`
	InfrastructureUIDs []uint32 `json:"infrastructureUids"`
	ReleaseUIDs        []uint32 `json:"releaseUids"`
	CertbotEmail       string   `json:"certbotEmail"`
	PM2User            string   `json:"pm2User"`
	PM2Home            string   `json:"pm2Home"`
	RetainReleases     int      `json:"retainReleases"`
	NginxAvailableDir  string   `json:"nginxAvailableDir"`
	NginxEnabledDir    string   `json:"nginxEnabledDir"`
	AcmeWebroot        string   `json:"acmeWebroot"`
	// Service makes this a supervised process target instead of a static site.
	// Static contracts omit it, so their canonical bytes and digest do not change.
	Service *ServiceConfig `json:"service,omitempty"`
	Extra   map[string]any `json:"-"`
}

func cleanAbsolute(value string) (string, error) {
	if value == "" || !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
		return "", errors.New("path must be absolute")
	}
	cleaned := filepath.Clean(value)
	if cleaned != value || cleaned == string(filepath.Separator) {
		return "", errors.New("path must already be canonical and non-root")
	}
	return cleaned, nil
}

func inside(root, prefix string) bool {
	if root == prefix {
		return true
	}
	relative, err := filepath.Rel(prefix, root)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func uniqueUIDs(values []uint32) bool {
	seen := map[uint32]bool{}
	for _, value := range values {
		if value == 0 || seen[value] {
			return false
		}
		seen[value] = true
	}
	return len(values) > 0
}

func (target *TargetConfig) normalize() {
	if target.NginxAvailableDir == "" {
		target.NginxAvailableDir = "/etc/nginx/sites-available"
	}
	if target.NginxEnabledDir == "" {
		target.NginxEnabledDir = "/etc/nginx/sites-enabled"
	}
	if target.AcmeWebroot == "" {
		target.AcmeWebroot = "/var/www/certbot"
	}
	sort.Slice(target.InfrastructureUIDs, func(i, j int) bool { return target.InfrastructureUIDs[i] < target.InfrastructureUIDs[j] })
	sort.Slice(target.ReleaseUIDs, func(i, j int) bool { return target.ReleaseUIDs[i] < target.ReleaseUIDs[j] })
}

func (target *TargetConfig) validate() error {
	target.normalize()
	if target.Schema != targetSchema {
		return errors.New("target schema is unsupported")
	}
	for label, value := range map[string]string{
		"revision": target.Revision, "targetId": target.TargetID, "projectId": target.ProjectID,
		"environmentId": target.EnvironmentID, "unitId": target.UnitID,
	} {
		if !idPattern.MatchString(value) {
			return fmt.Errorf("%s is invalid", label)
		}
	}
	if !hostnamePattern.MatchString(target.Hostname) || net.ParseIP(target.Hostname) != nil {
		return errors.New("hostname is invalid")
	}
	root, err := cleanAbsolute(target.CanonicalRoot)
	if err != nil {
		return fmt.Errorf("canonicalRoot: %w", err)
	}
	prefix, err := cleanAbsolute(target.AllowedRootPrefix)
	if err != nil {
		return fmt.Errorf("allowedRootPrefix: %w", err)
	}
	if !inside(root, prefix) || root == prefix {
		return errors.New("canonicalRoot must be a child of allowedRootPrefix")
	}
	for label, value := range map[string]string{
		"nginxAvailableDir": target.NginxAvailableDir, "nginxEnabledDir": target.NginxEnabledDir,
		"acmeWebroot": target.AcmeWebroot, "pm2Home": target.PM2Home,
	} {
		if _, err := cleanAbsolute(value); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	if target.DeployUID == 0 || target.DeployGID == 0 || !uniqueUIDs(target.InfrastructureUIDs) || !uniqueUIDs(target.ReleaseUIDs) {
		return errors.New("deploy and authorized role IDs must be explicit non-root IDs")
	}
	if target.RetainReleases < 5 || target.RetainReleases > 100 {
		return errors.New("retainReleases must be between 5 and 100")
	}
	if target.PM2User == "" || strings.ContainsAny(target.PM2User, "\x00\r\n:") {
		return errors.New("pm2User is invalid")
	}
	if _, err := mail.ParseAddress(target.CertbotEmail); err != nil {
		return errors.New("certbotEmail is invalid")
	}
	if target.Service != nil {
		if err := target.Service.validate(*target); err != nil {
			return fmt.Errorf("service: %w", err)
		}
	}
	return nil
}

func targetFilename(configDir, targetID string) string {
	digest := sha256.Sum256([]byte(targetID))
	return filepath.Join(configDir, hex.EncodeToString(digest[:])+".json")
}

func loadTarget(configDir, targetID string) (TargetConfig, []byte, error) {
	if !idPattern.MatchString(targetID) {
		return TargetConfig{}, nil, errors.New("target ID is invalid")
	}
	raw, err := os.ReadFile(targetFilename(configDir, targetID))
	if err != nil {
		return TargetConfig{}, nil, err
	}
	var target TargetConfig
	if err := decodeStrict(raw, &target); err != nil {
		return TargetConfig{}, nil, err
	}
	if target.TargetID != targetID {
		return TargetConfig{}, nil, errors.New("target file identity mismatch")
	}
	if err := target.validate(); err != nil {
		return TargetConfig{}, nil, err
	}
	canonical, err := json.Marshal(target)
	return target, canonical, err
}
