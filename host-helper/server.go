package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"slices"
	"syscall"
	"time"
)

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var correlationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,499}$`)

type helperServer struct {
	configDir string
	stateDir  string
}

func peerUID(connection *net.UnixConn) (uint32, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return 0, err
	}
	var credential *syscall.Ucred
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		credential, socketErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return 0, err
	}
	if socketErr != nil {
		return 0, socketErr
	}
	return credential.Uid, nil
}

func infrastructureOperation(operation string) bool {
	switch operation {
	case "observe-resource", "observe-target", "reconcile-release-directory", "reconcile-ingress-http",
		"reconcile-certificate", "reconcile-ingress-tls", "validate-nginx", "reload-nginx",
		"snapshot-pm2", "compare-pm2", "reconcile-service", "reconcile-service-secrets", "observe-service":
		return true
	default:
		return false
	}
}

func releaseOperation(operation string) bool {
	switch operation {
	case "observe-target", "list-releases", "stage-static-release", "deploy-static-release", "activate-static-release", "rollback-static-release",
		"observe-service", "deploy-service-release", "activate-service-release", "rollback-service-release":
		return true
	default:
		return false
	}
}

func authorize(target TargetConfig, uid uint32, operation string) bool {
	return (infrastructureOperation(operation) && slices.Contains(target.InfrastructureUIDs, uid)) ||
		(releaseOperation(operation) && slices.Contains(target.ReleaseUIDs, uid))
}

func validateRequest(request Request, target TargetConfig) error {
	if request.TargetID != target.TargetID || !idPattern.MatchString(request.RequestID) {
		return errors.New("request identity is invalid")
	}
	if len(request.Desired) == 0 || len(request.Desired) > maxHeaderBytes {
		return errors.New("desired payload is missing or too large")
	}
	mutating := !slices.Contains([]string{"observe-resource", "observe-target", "list-releases", "snapshot-pm2", "compare-pm2", "validate-nginx", "observe-service"}, request.Operation)
	if mutating {
		if !correlationPattern.MatchString(request.IdempotencyKey) || !digestPattern.MatchString(request.PlanDigest) {
			return errors.New("mutation correlation is invalid")
		}
		expires, err := time.Parse(time.RFC3339, request.ExpiresAt)
		if err != nil || !expires.After(time.Now()) || expires.After(time.Now().Add(2*time.Hour)) {
			return errors.New("mutation approval is expired or outside the maximum window")
		}
	}
	if !slices.Contains([]string{"stage-static-release", "deploy-static-release", "deploy-service-release"}, request.Operation) && request.ArchiveBytes != 0 {
		return errors.New("only staging accepts archive bytes")
	}
	return nil
}

func (server *helperServer) handle(connection *net.UnixConn) {
	defer connection.Close()
	uid, err := peerUID(connection)
	if err != nil {
		_ = writeFrame(connection, Response{Schema: responseSchema, Outcome: "failed", Code: "peer-invalid", Detail: "caller identity is unavailable", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
		return
	}
	request, archive, err := readFrame(connection)
	response := Response{
		Schema: responseSchema, RequestID: request.RequestID, TargetID: request.TargetID,
		Operation: request.Operation, Outcome: "failed", Code: "helper-invalid",
		Detail: "request was refused", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err == nil {
		var target TargetConfig
		var targetRaw []byte
		target, targetRaw, err = loadTarget(server.configDir, request.TargetID)
		if err == nil && !authorize(target, uid, request.Operation) {
			err = errors.New("caller is not enrolled for this target operation")
			response.Code = "not-authorized"
		}
		if err == nil {
			err = validateRequest(request, target)
		}
		if err == nil {
			targetDigest := sha256.Sum256(targetRaw)
			lockDigest := sha256.Sum256([]byte(target.TargetID))
			lockPath := fmt.Sprintf("%s/locks/%s.lock", server.stateDir, hex.EncodeToString(lockDigest[:]))
			var data any
			data, err = withFileLock(lockPath, func() (any, error) {
				return executeOperation(server.stateDir, target, "sha256:"+hex.EncodeToString(targetDigest[:]), request, archive)
			})
			if err == nil {
				response.Outcome = "succeeded"
				response.Code = "ok"
				response.Detail = "operation completed and was observed"
				response.Data = data
			}
		}
	}
	if err != nil {
		response.Detail = boundedError(err)
	}
	_ = writeFrame(connection, response)
}

func boundedError(err error) string {
	message := err.Error()
	if len(message) > 400 {
		message = message[:400]
	}
	return message
}

func consumeAll(reader io.Reader) error {
	_, err := io.Copy(io.Discard, reader)
	return err
}
