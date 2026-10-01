package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func receiptPath(target TargetConfig, releaseID string) string {
	return filepath.Join(target.CanonicalRoot, "releases", releaseID, "release.json")
}

func readReceipt(target TargetConfig, releaseID string) (releaseReceipt, error) {
	if !idPattern.MatchString(releaseID) {
		return releaseReceipt{}, errors.New("release ID is invalid")
	}
	raw, err := os.ReadFile(receiptPath(target, releaseID))
	if err != nil {
		return releaseReceipt{}, err
	}
	var receipt releaseReceipt
	if err := decodeStrict(raw, &receipt); err != nil {
		return releaseReceipt{}, err
	}
	if receipt.Schema != "psm.werewolf.solutions/target-release/v1" || receipt.TargetID != target.TargetID || receipt.ReleaseID != releaseID {
		return releaseReceipt{}, errors.New("release receipt identity is invalid")
	}
	return receipt, nil
}

func stageRelease(target TargetConfig, targetDigest string, request Request, archive io.Reader) (any, error) {
	var desired stageDesired
	if err := decodeDesired(request.Desired, &desired); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(desired.ReleaseID) || !idPattern.MatchString(desired.ArtifactID) || !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(desired.CommitSHA) || !idPattern.MatchString(desired.Version) {
		return nil, errors.New("release or artifact identity is invalid")
	}
	if desired.PayloadAlgorithm != payloadAlgorithm || !digestPattern.MatchString(desired.PayloadDigest) || !digestPattern.MatchString(desired.ArchiveDigest) {
		return nil, errors.New("artifact digest contract is invalid")
	}
	if desired.MaximumFiles < 1 || desired.MaximumFiles > 100_000 || desired.MaximumBytes < 1 || desired.MaximumBytes > 1024*1024*1024 {
		return nil, errors.New("payload limits are invalid")
	}
	if existing, err := readReceipt(target, desired.ReleaseID); err == nil {
		if existing.PayloadDigest == desired.PayloadDigest && existing.ArchiveDigest == desired.ArchiveDigest && existing.ArtifactID == desired.ArtifactID {
			// A release staged by an older helper kept the service umask's private
			// modes; restaging the same release repairs them for nginx.
			if err := publishRelease(filepath.Join(target.CanonicalRoot, "releases", desired.ReleaseID)); err != nil {
				return nil, err
			}
			return existing, nil
		}
		return nil, errors.New("release ID already exists with another identity")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := requireNoSymlinks(target.CanonicalRoot, false); err != nil {
		return nil, err
	}
	nonce := sha256.Sum256([]byte(request.IdempotencyKey))
	incoming := filepath.Join(target.CanonicalRoot, "incoming", hex.EncodeToString(nonce[:16]))
	if err := os.RemoveAll(incoming); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(incoming, "site"), 0755); err != nil {
		return nil, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(incoming)
		}
	}()

	archiveHash := sha256.New()
	counting := &countingReader{reader: archive}
	tape := tar.NewReader(io.TeeReader(counting, archiveHash))
	seen := map[string]bool{}
	var extractedBytes int64
	var extractedFiles int
	for {
		header, err := tape.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read archive: %w", err)
		}
		// tar conventionally appends '/' to directory headers. Normalize only
		// that suffix before applying the strict relative-path check.
		archiveName := header.Name
		if header.Typeflag == tar.TypeDir {
			archiveName = strings.TrimSuffix(archiveName, "/")
		}
		name, err := canonicalRelativePath(archiveName)
		if err != nil || (name != "site" && !strings.HasPrefix(name, "site/")) {
			return nil, errors.New("archive path is outside site/")
		}
		if seen[name] {
			return nil, errors.New("archive contains a duplicate path")
		}
		seen[name] = true
		destination := filepath.Join(incoming, filepath.FromSlash(name))
		if !inside(destination, incoming) {
			return nil, errors.New("archive path escaped incoming directory")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(destination, 0755); err != nil {
				return nil, err
			}
		case tar.TypeReg, tar.TypeRegA:
			if name == "site" || header.Size < 0 {
				return nil, errors.New("archive file is invalid")
			}
			extractedFiles++
			extractedBytes += header.Size
			if extractedFiles > desired.MaximumFiles || extractedBytes > desired.MaximumBytes {
				return nil, errors.New("archive exceeds approved payload limits")
			}
			if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
				return nil, err
			}
			file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
			if err != nil {
				return nil, err
			}
			written, copyErr := io.Copy(file, io.LimitReader(tape, header.Size))
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil || written != header.Size {
				return nil, errors.New("archive file was truncated")
			}
		default:
			return nil, errors.New("archive contains a link or special entry")
		}
	}
	if err := consumeAll(io.TeeReader(counting, archiveHash)); err != nil {
		return nil, err
	}
	if counting.count != request.ArchiveBytes {
		return nil, errors.New("archive byte count differs from the request")
	}
	observedArchive := "sha256:" + hex.EncodeToString(archiveHash.Sum(nil))
	if observedArchive != desired.ArchiveDigest {
		return nil, errors.New("transport archive digest mismatch")
	}
	if _, err := os.Stat(filepath.Join(incoming, "site", "version.json")); err != nil {
		return nil, errors.New("payload has no generated version.json")
	}
	observedPayload, fileCount, payloadBytes, err := payloadDigest(filepath.Join(incoming, "site"), desired.MaximumFiles, desired.MaximumBytes)
	if err != nil {
		return nil, err
	}
	if observedPayload != desired.PayloadDigest {
		return nil, errors.New("extracted payload digest mismatch")
	}
	if err := publishRelease(incoming); err != nil {
		return nil, err
	}
	receipt := releaseReceipt{
		Schema: "psm.werewolf.solutions/target-release/v1", TargetID: target.TargetID, TargetDigest: targetDigest,
		ReleaseID: desired.ReleaseID, ArtifactID: desired.ArtifactID, CommitSHA: desired.CommitSHA, Version: desired.Version,
		PayloadAlgorithm: desired.PayloadAlgorithm, PayloadDigest: desired.PayloadDigest, ArchiveDigest: desired.ArchiveDigest,
		FileCount: fileCount, PayloadBytes: payloadBytes, StagedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	receiptRaw, _ := json.MarshalIndent(receipt, "", "  ")
	receiptRaw = append(receiptRaw, '\n')
	if err := writeAtomic(filepath.Join(incoming, "release.json"), receiptRaw, 0644, int(target.DeployUID), int(target.DeployGID)); err != nil {
		return nil, err
	}
	final := filepath.Join(target.CanonicalRoot, "releases", desired.ReleaseID)
	if _, err := os.Lstat(final); err == nil {
		return nil, errors.New("release directory already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.Rename(incoming, final); err != nil {
		return nil, err
	}
	cleanup = false
	return receipt, nil
}

// publishRelease makes a staged release readable by nginx whatever the helper's
// UMask (0027 in the shipped unit): directories 0755, files 0644. Modes are not
// part of the payload digest, and a link or special file is refused outright.
func publishRelease(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		switch {
		case entry.IsDir():
			return os.Chmod(path, 0755)
		case entry.Type().IsRegular():
			return os.Chmod(path, 0644)
		default:
			return errors.New("release contains a link or special file")
		}
	})
}

type countingReader struct {
	reader io.Reader
	count  int64
}

func (reader *countingReader) Read(value []byte) (int, error) {
	count, err := reader.reader.Read(value)
	reader.count += int64(count)
	return count, err
}

func activeRelease(target TargetConfig) (*releaseReceipt, error) {
	link, err := os.Readlink(filepath.Join(target.CanonicalRoot, "current"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	parts := strings.Split(filepath.ToSlash(link), "/")
	if len(parts) != 3 || parts[0] != "releases" || parts[2] != "site" || !idPattern.MatchString(parts[1]) {
		return nil, errors.New("current link is outside the release layout")
	}
	receipt, err := readReceipt(target, parts[1])
	return &receipt, err
}

func activateRelease(stateDir string, target TargetConfig, targetDigest string, raw json.RawMessage) (any, error) {
	var desired activateDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(desired.ReleaseID) || !digestPattern.MatchString(desired.PayloadDigest) {
		return nil, errors.New("activation identity is invalid")
	}
	intended, err := readReceipt(target, desired.ReleaseID)
	if err != nil {
		return nil, err
	}
	if intended.PayloadDigest != desired.PayloadDigest || intended.TargetDigest != targetDigest {
		return nil, errors.New("staged release identity differs from activation")
	}
	current, err := activeRelease(target)
	if err != nil {
		return nil, err
	}
	if current != nil && current.ReleaseID == intended.ReleaseID && current.PayloadDigest == intended.PayloadDigest {
		return map[string]any{"active": intended, "previousReleaseId": nil, "idempotent": true}, nil
	}
	if desired.ExpectedCurrentReleaseID == nil {
		if current != nil {
			return nil, errors.New("expected no active release but one exists")
		}
	} else if current == nil || current.ReleaseID != *desired.ExpectedCurrentReleaseID || desired.ExpectedCurrentPayloadDigest == nil || current.PayloadDigest != *desired.ExpectedCurrentPayloadDigest {
		return nil, errors.New("active release changed before activation")
	}
	temporary := filepath.Join(target.CanonicalRoot, ".current-"+desired.ReleaseID)
	_ = os.Remove(temporary)
	if err := os.Symlink(filepath.ToSlash(filepath.Join("releases", desired.ReleaseID, "site")), temporary); err != nil {
		return nil, err
	}
	if err := os.Rename(temporary, filepath.Join(target.CanonicalRoot, "current")); err != nil {
		_ = os.Remove(temporary)
		return nil, err
	}
	activation := map[string]any{
		"schema": "psm.werewolf.solutions/target-activation/v1", "targetId": target.TargetID,
		"targetDigest": targetDigest, "releaseId": intended.ReleaseID, "payloadDigest": intended.PayloadDigest,
		"previousReleaseId": func() any {
			if current == nil {
				return nil
			}
			return current.ReleaseID
		}(),
		"activatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}
	rawActivation, _ := json.MarshalIndent(activation, "", "  ")
	rawActivation = append(rawActivation, '\n')
	if err := writeAtomic(filepath.Join(stateDir, "receipts", target.TargetID, "active.json"), rawActivation, 0640, os.Geteuid(), os.Getegid()); err != nil {
		return nil, err
	}
	if err := garbageCollect(target, intended.ReleaseID, func() string {
		if current == nil {
			return ""
		}
		return current.ReleaseID
	}()); err != nil {
		return nil, err
	}
	return map[string]any{"active": intended, "activation": activation}, nil
}

func garbageCollect(target TargetConfig, activeID, previousID string) error {
	entries, err := os.ReadDir(filepath.Join(target.CanonicalRoot, "releases"))
	if err != nil {
		return err
	}
	type release struct {
		id string
		at time.Time
	}
	releases := []release{}
	for _, entry := range entries {
		if !entry.IsDir() || !idPattern.MatchString(entry.Name()) {
			continue
		}
		receipt, err := readReceipt(target, entry.Name())
		if err != nil {
			continue
		}
		staged, _ := time.Parse(time.RFC3339Nano, receipt.StagedAt)
		releases = append(releases, release{id: entry.Name(), at: staged})
	}
	sort.Slice(releases, func(i, j int) bool { return releases[i].at.After(releases[j].at) })
	keep := map[string]bool{activeID: true}
	if previousID != "" {
		keep[previousID] = true
	}
	for index, release := range releases {
		if index < target.RetainReleases {
			keep[release.id] = true
		}
	}
	for _, release := range releases {
		if !keep[release.id] {
			if err := os.RemoveAll(filepath.Join(target.CanonicalRoot, "releases", release.id)); err != nil {
				return err
			}
		}
	}
	return nil
}

func observeTarget(target TargetConfig, targetDigest string) (any, error) {
	current, err := activeRelease(target)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(target.CanonicalRoot, "releases"))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{"targetId": target.TargetID, "targetDigest": targetDigest, "layout": "missing", "active": nil, "releases": []any{}}, nil
	}
	if err != nil {
		return nil, err
	}
	receipts := []releaseReceipt{}
	for _, entry := range entries {
		if entry.IsDir() {
			if receipt, readErr := readReceipt(target, entry.Name()); readErr == nil {
				receipts = append(receipts, receipt)
			}
		}
	}
	sort.Slice(receipts, func(i, j int) bool { return receipts[i].StagedAt > receipts[j].StagedAt })
	return map[string]any{"targetId": target.TargetID, "targetDigest": targetDigest, "layout": "ready", "active": current, "releases": receipts}, nil
}
