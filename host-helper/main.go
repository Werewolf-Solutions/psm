package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

const (
	defaultConfigDir = "/etc/psm-deploy/targets"
	defaultStateDir  = "/var/lib/psm-deploy"
	defaultSocket    = "/run/psm-deploy/helper.sock"
)

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "psm-host-helper: "+format+"\n", args...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fatalf("expected enroll, serve, client or digest")
	}
	switch os.Args[1] {
	case "enroll":
		enroll(os.Args[2:])
	case "serve":
		serve(os.Args[2:])
	case "client":
		client(os.Args[2:])
	case "digest":
		digestCommand(os.Args[2:])
	default:
		fatalf("unknown command")
	}
}

func digestCommand(args []string) {
	flags := flag.NewFlagSet("digest", flag.ExitOnError)
	root := flags.String("root", "", "payload tree")
	maximumFiles := flags.Int("max-files", 100000, "maximum files")
	maximumBytes := flags.Int64("max-bytes", 1024*1024*1024, "maximum unpacked bytes")
	_ = flags.Parse(args)
	if *root == "" || flags.NArg() != 0 {
		fatalf("digest requires --root and accepts no positional arguments")
	}
	digest, files, bytes, err := payloadDigest(*root, *maximumFiles, *maximumBytes)
	if err != nil {
		fatalf("digest payload: %v", err)
	}
	result, _ := json.Marshal(map[string]any{"algorithm": payloadAlgorithm, "digest": digest, "files": files, "bytes": bytes})
	fmt.Printf("%s\n", result)
}

func enroll(args []string) {
	flags := flag.NewFlagSet("enroll", flag.ExitOnError)
	configDir := flags.String("config-dir", defaultConfigDir, "root-owned target directory")
	stateDir := flags.String("state-dir", defaultStateDir, "root-owned state directory")
	_ = flags.Parse(args)
	if os.Geteuid() != 0 {
		fatalf("enrollment requires root")
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxHeaderBytes+1))
	if err != nil || len(raw) > maxHeaderBytes {
		fatalf("target contract is unreadable or too large")
	}
	var target TargetConfig
	if err := decodeStrict(raw, &target); err != nil {
		fatalf("invalid target contract: %v", err)
	}
	if err := target.validate(); err != nil {
		fatalf("invalid target contract: %v", err)
	}
	canonical, _ := json.MarshalIndent(target, "", "  ")
	canonical = append(canonical, '\n')
	if err := os.MkdirAll(*configDir, 0750); err != nil {
		fatalf("create config directory: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(*stateDir, "locks"), 0750); err != nil {
		fatalf("create lock directory: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(*stateDir, "receipts", target.TargetID), 0750); err != nil {
		fatalf("create receipt directory: %v", err)
	}
	if err := writeAtomic(targetFilename(*configDir, target.TargetID), canonical, 0640, 0, 0); err != nil {
		fatalf("write target contract: %v", err)
	}
	fmt.Printf("enrolled %s revision %s\n", target.TargetID, target.Revision)
}

func serve(args []string) {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	configDir := flags.String("config-dir", defaultConfigDir, "root-owned target directory")
	stateDir := flags.String("state-dir", defaultStateDir, "root-owned state directory")
	socket := flags.String("socket", defaultSocket, "Unix socket")
	socketGID := flags.Int("socket-gid", -1, "group allowed to connect")
	socketGroup := flags.String("socket-group", "", "group name allowed to connect")
	_ = flags.Parse(args)
	if os.Geteuid() != 0 {
		fatalf("serve requires root")
	}
	if err := os.MkdirAll(filepath.Dir(*socket), 0755); err != nil {
		fatalf("create runtime directory: %v", err)
	}
	if info, err := os.Lstat(*socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			fatalf("refusing to replace non-socket %s", *socket)
		}
		if err := os.Remove(*socket); err != nil {
			fatalf("remove stale socket: %v", err)
		}
	}
	listener, err := net.Listen("unix", *socket)
	if err != nil {
		fatalf("listen: %v", err)
	}
	defer listener.Close()
	resolvedSocketGID := *socketGID
	if *socketGroup != "" {
		if *socketGID >= 0 {
			fatalf("socket-gid and socket-group are mutually exclusive")
		}
		group, err := user.LookupGroup(*socketGroup)
		if err != nil {
			fatalf("resolve socket group: %v", err)
		}
		resolvedSocketGID, err = strconv.Atoi(group.Gid)
		if err != nil || resolvedSocketGID <= 0 {
			fatalf("socket group has an invalid numeric ID")
		}
	}
	if resolvedSocketGID >= 0 {
		if err := os.Chown(*socket, 0, resolvedSocketGID); err != nil {
			fatalf("set socket group: %v", err)
		}
	}
	if err := os.Chmod(*socket, 0660); err != nil {
		fatalf("set socket mode: %v", err)
	}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-interrupt; _ = listener.Close() }()
	server := &helperServer{configDir: *configDir, stateDir: *stateDir}
	for {
		connection, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		go server.handle(connection.(*net.UnixConn))
	}
}

func client(args []string) {
	flags := flag.NewFlagSet("client", flag.ExitOnError)
	socket := flags.String("socket", defaultSocket, "Unix socket")
	_ = flags.Parse(args)
	connection, err := net.Dial("unix", *socket)
	if err != nil {
		fatalf("connect: %v", err)
	}
	defer connection.Close()
	done := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(connection, io.LimitReader(os.Stdin, 2*1024*1024*1024+maxHeaderBytes+4))
		if unix, ok := connection.(*net.UnixConn); ok {
			_ = unix.CloseWrite()
		}
		done <- copyErr
	}()
	if _, err := io.Copy(os.Stdout, io.LimitReader(connection, maxResultBytes+4)); err != nil {
		fatalf("read response: %v", err)
	}
	if err := <-done; err != nil {
		fatalf("send request: %v", err)
	}
}
