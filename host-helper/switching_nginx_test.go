package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// slotProcess stands in for one systemd unit: it serves the release `current`
// named when it started, as a Node process would, and dies without draining.
type slotProcess struct {
	server  *http.Server
	release string
	proxied atomic.Int64
}

// Real nginx, real traffic. Opt in with PSM_SWITCH_DOCKER=1 (needs nginx:1.27-alpine).
// systemd is replaced by in-process servers; nginx -t and reload reach the container.
func TestSwitchingThroughRealNginxDropsNoRequests(t *testing.T) {
	if os.Getenv("PSM_SWITCH_DOCKER") != "1" {
		t.Skip("set PSM_SWITCH_DOCKER=1")
	}
	freePort := func() int {
		for port := servicePortMinimum + 700; port <= servicePortMaximum; port++ {
			listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
			if err == nil {
				listener.Close()
				return port
			}
		}
		t.Fatal("no free port")
		return 0
	}
	target := serviceTarget(t, freePort())
	target.Service.AlternatePort, target.Service.DrainSeconds = target.Service.Port+1, 1
	if err := target.validate(); err != nil {
		t.Fatal(err)
	}
	base := filepath.Dir(filepath.Dir(target.CanonicalRoot))
	installFakeHost(t, target.Service)

	var mu sync.Mutex
	slots := map[string]*slotProcess{}
	ports := map[string]int{}
	for _, slot := range serviceSlots(target) {
		ports[slot.Unit] = slot.Port
	}
	stop := func(unit string) {
		if process := slots[unit]; process != nil {
			_ = process.server.Close()
			delete(slots, unit)
		}
	}
	start := func(unit string) error {
		stop(unit)
		link, _ := os.Readlink(filepath.Join(target.CanonicalRoot, "current"))
		process := &slotProcess{release: filepath.Base(filepath.Dir(link))}
		process.server = &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/healthz" {
				if strings.Contains(process.release, "broken") {
					writer.WriteHeader(http.StatusInternalServerError)
				}
				return
			}
			process.proxied.Add(1)
			if request.URL.Path == "/slow" {
				time.Sleep(300 * time.Millisecond)
			}
			_, _ = io.WriteString(writer, process.release)
		})}
		listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", ports[unit]))
		if err != nil {
			return err
		}
		slots[unit] = process
		go func() { _ = process.server.Serve(listener) }()
		return nil
	}
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for unit := range slots {
			stop(unit)
		}
	})

	nginxPort := target.Service.Port + 2
	container := fmt.Sprintf("psm-switch-test-%d", os.Getpid())
	docker := func(args ...string) (string, error) {
		output, err := exec.Command("docker", args...).CombinedOutput()
		return string(output), err
	}
	fake := runCommand
	runCommand = func(name string, args ...string) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case name == "systemctl" && args[0] == "restart":
			return nil, start(args[1])
		case name == "systemctl" && args[0] == "stop":
			stop(args[1])
			return nil, nil
		case name == "nginx":
			if output, err := docker("exec", container, "nginx", "-t"); err != nil {
				return nil, errors.New(output)
			}
			return nil, nil
		case name == "systemctl" && args[0] == "reload":
			if output, err := docker("exec", container, "nginx", "-s", "reload"); err != nil {
				return nil, errors.New(output)
			}
			return nil, nil
		}
		return fake(name, args...)
	}
	drainWait = time.Sleep

	desired := serviceDesiredFor(target, map[string]string{})
	desired.Switching, desired.DrainSeconds = "health-checked", 1
	if _, err := reconcileService(target, mustJSON(desired)); err != nil {
		t.Fatal(err)
	}
	site, err := renderProxy(target, proxyIngressDesired{Hostname: target.Hostname, SecurityHeaders: "app-managed@1", MaxBodyMB: 1}, true)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(filepath.Dir(nginxPath(target)), 0755)
	if err := os.WriteFile(nginxPath(target), site, 0644); err != nil {
		t.Fatal(err)
	}
	// The same upstream and proxy directives as the rendered site, without its TLS listener.
	configuration := fmt.Sprintf(`events {}
http {
  access_log off;
  upstream %[1]s { include %[2]s; }
  server {
    listen 127.0.0.1:%[3]d;
    location / {
      proxy_pass http://%[1]s;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_connect_timeout 5s;
      proxy_read_timeout 60s;
    }
  }
}
`, target.Service.UnitName, upstreamFile(target), nginxPort)
	configFile := filepath.Join(base, "nginx.conf")
	if err := os.WriteFile(configFile, []byte(configuration), 0644); err != nil {
		t.Fatal(err)
	}
	// nginx reads the upstream file from the same absolute path the helper writes.
	_ = filepath.WalkDir(base, func(path string, entry os.DirEntry, _ error) error {
		if entry != nil && entry.IsDir() {
			_ = os.Chmod(path, 0755)
		}
		return nil
	})
	for directory := base; directory != "/" && strings.HasPrefix(directory, os.TempDir()+"/"); directory = filepath.Dir(directory) {
		_ = os.Chmod(directory, 0755)
	}

	if output, err := docker("run", "-d", "--rm", "--name", container, "--network", "host", "-v", base+":"+base+":ro",
		"nginx:1.27-alpine", "nginx", "-c", configFile, "-g", "daemon off;"); err != nil {
		t.Fatalf("nginx did not start: %s", output)
	}
	t.Cleanup(func() { _, _ = docker("rm", "-f", container) })
	digest, stateDir := "sha256:"+strings.Repeat("b", 64), t.TempDir()
	deploy := func(version string, previous, previousPayload *string, rollback bool) (string, string, error) {
		request, archive, payload := deployRequest(t, version, previous, previousPayload)
		var desired deployReleaseDesired
		_ = decodeDesired(request.Desired, &desired)
		desired.RollbackAllowed = rollback
		request.Desired = mustJSON(desired)
		_, err := deployServiceRelease(stateDir, target, digest, request, bytes.NewReader(archive))
		return desired.Stage.ReleaseID, payload, err
	}
	// The first release has nothing to protect; traffic starts once it is up.
	firstID, firstPayload, err := deploy("1.0.0", nil, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	origin := fmt.Sprintf("http://127.0.0.1:%d", nginxPort)
	for attempt := 0; ; attempt++ {
		response, err := http.Get(origin + "/")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if attempt > 100 {
			logs, _ := docker("logs", container)
			t.Fatalf("nginx never served the first release: %v\n%s", err, logs)
		}
		time.Sleep(100 * time.Millisecond)
	}

	var sent, failed atomic.Int64
	var seenMu sync.Mutex
	seen, failures := map[string]int{}, []string{}
	done := make(chan struct{})
	var workers sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		workers.Add(1)
		path := "/"
		if worker%4 == 0 {
			path = "/slow"
		}
		go func() {
			defer workers.Done()
			client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
			for {
				select {
				case <-done:
					return
				default:
				}
				sent.Add(1)
				response, err := client.Get(origin + path)
				detail := ""
				if err != nil {
					detail = err.Error()
				} else {
					body, _ := io.ReadAll(response.Body)
					response.Body.Close()
					if response.StatusCode != http.StatusOK {
						detail = fmt.Sprintf("HTTP %d", response.StatusCode)
					}
					seenMu.Lock()
					seen[string(body)]++
					seenMu.Unlock()
				}
				if detail != "" {
					failed.Add(1)
					seenMu.Lock()
					if len(failures) < 5 {
						failures = append(failures, detail)
					}
					seenMu.Unlock()
				}
			}
		}()
	}
	time.Sleep(500 * time.Millisecond)
	secondID, secondPayload, err := deploy("1.1.0", &firstID, &firstPayload, true)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	thirdID, thirdPayload, err := deploy("1.2.0", &secondID, &secondPayload, true)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	// A candidate that fails its gate, with and without rollback authority.
	if _, _, err := deploy("1.3.0-broken", &thirdID, &thirdPayload, false); err == nil || !strings.Contains(err.Error(), "received no traffic") {
		t.Fatalf("the broken release was not stopped at its gate: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	close(done)
	workers.Wait()

	t.Logf("requests %d, failed %d, answered by %v", sent.Load(), failed.Load(), seen)
	if failed.Load() != 0 {
		t.Fatalf("%d of %d requests failed during switching: %v", failed.Load(), sent.Load(), failures)
	}
	for _, release := range []string{"rel_1_0_0", "rel_1_1_0", "rel_1_2_0"} {
		if seen[release] == 0 {
			t.Fatalf("no request was answered by %s: %v", release, seen)
		}
	}
	for release := range seen {
		if strings.Contains(release, "broken") {
			t.Fatalf("the failing candidate answered public requests: %v", seen)
		}
	}
	if live, _, _ := liveSlot(target); slots[live.Unit] == nil || slots[live.Unit].release != "rel_1_2_0" || len(slots) != 1 {
		t.Fatalf("after the failed gate exactly the previous release must still serve: %v", slots)
	}
}
