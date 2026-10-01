package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

const payloadAlgorithm = "psm-static-tree-sha256@1"

// serviceAlgorithm is the static tree algorithm plus each file's executable bit:
// a service release carries its runtime, whose binaries must stay executable.
const serviceAlgorithm = "psm-service-tree-sha256@1"

type payloadFile struct {
	path       string
	size       int64
	digest     [32]byte
	executable bool
}

func canonicalRelativePath(value string) (string, error) {
	if value == "" || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) || !norm.NFC.IsNormalString(value) {
		return "", fmt.Errorf("path is empty, non-NFC or contains a forbidden character")
	}
	cleaned := filepath.ToSlash(filepath.Clean(value))
	if cleaned != value || cleaned == "." || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
		return "", fmt.Errorf("path is not canonical")
	}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == "" || segment == "." || segment == ".." || !norm.NFC.IsNormalString(segment) {
			return "", fmt.Errorf("path segment is invalid")
		}
	}
	return cleaned, nil
}

func payloadDigest(root string, maximumFiles int, maximumBytes int64) (string, int, int64, error) {
	return treeDigest(payloadAlgorithm, root, maximumFiles, maximumBytes)
}

func treeDigest(algorithm, root string, maximumFiles int, maximumBytes int64) (string, int, int64, error) {
	if algorithm != payloadAlgorithm && algorithm != serviceAlgorithm {
		return "", 0, 0, fmt.Errorf("payload algorithm is unsupported")
	}
	files := []payloadFile{}
	var total int64
	err := filepath.WalkDir(root, func(pathname string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if pathname == root {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !info.Mode().IsRegular()) {
			return fmt.Errorf("payload contains a non-regular entry")
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, pathname)
		if err != nil {
			return err
		}
		relative, err = canonicalRelativePath(filepath.ToSlash(relative))
		if err != nil {
			return err
		}
		file, err := os.Open(pathname)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		var digest [32]byte
		copy(digest[:], hash.Sum(nil))
		total += info.Size()
		files = append(files, payloadFile{path: relative, size: info.Size(), digest: digest, executable: info.Mode().Perm()&0o111 != 0})
		if len(files) > maximumFiles || total > maximumBytes {
			return fmt.Errorf("payload exceeds its approved limits")
		}
		return nil
	})
	if err != nil {
		return "", 0, 0, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
	hash := sha256.New()
	hash.Write([]byte(algorithm))
	hash.Write([]byte{0})
	for _, file := range files {
		pathBytes := []byte(file.path)
		hash.Write([]byte{1})
		_ = binary.Write(hash, binary.BigEndian, uint32(len(pathBytes)))
		hash.Write(pathBytes)
		_ = binary.Write(hash, binary.BigEndian, uint64(file.size))
		hash.Write(file.digest[:])
		if algorithm == serviceAlgorithm {
			mode := byte(0)
			if file.executable {
				mode = 1
			}
			hash.Write([]byte{mode})
		}
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), len(files), total, nil
}
