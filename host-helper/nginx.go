package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"text/template"
)

type ingressDesired struct {
	Hostname        string   `json:"hostname"`
	DocumentRoot    string   `json:"documentRoot"`
	SPAFallback     bool     `json:"spaFallback"`
	DenyPrefixes    []string `json:"denyPrefixes"`
	CachePolicy     string   `json:"cachePolicy"`
	SecurityHeaders string   `json:"securityHeaders"`
}

const nginxTemplate = `# managed-by: psm-host-helper/v1
# target: {{.TargetID}}
server {
    listen 80;
    listen [::]:80;
    server_name {{.Hostname}};

    location ^~ /.well-known/acme-challenge/ {
        root {{.AcmeWebroot}};
        try_files $uri =404;
    }
{{if .TLS}}
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{.Hostname}};
    root {{.DocumentRoot}};
    index index.html;
    ssl_certificate /etc/letsencrypt/live/{{.Hostname}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{.Hostname}}/privkey.pem;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'" always;
{{range .DenyPrefixes}}
    location ^~ {{.}} { return 404; }
{{end}}
{{if .NoCache}}
    location / {
        add_header Cache-Control "no-cache" always;
        try_files $uri $uri/ {{if .SPAFallback}}/index.html{{else}}=404{{end}};
    }
{{else}}
    location ^~ /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }
    location = /index.html { add_header Cache-Control "no-cache" always; }
    location / { try_files $uri $uri/ {{if .SPAFallback}}/index.html{{else}}=404{{end}}; }
{{end}}
{{else}}
    location / { return 404; }
{{end}}
}
`

func validateIngress(target TargetConfig, desired ingressDesired) error {
	if desired.Hostname != target.Hostname || desired.DocumentRoot != target.CanonicalRoot+"/current" {
		return fmt.Errorf("ingress hostname or document root differs from the enrolled target")
	}
	if desired.SecurityHeaders != "werewolf-static-spa@1" {
		return fmt.Errorf("security header profile is unsupported")
	}
	if desired.CachePolicy != "vite-hashed" && desired.CachePolicy != "no-cache" {
		return fmt.Errorf("cache policy is unsupported")
	}
	for _, prefix := range desired.DenyPrefixes {
		if !strings.HasPrefix(prefix, "/") || strings.ContainsAny(prefix, "{};\r\n\x00 ") {
			return fmt.Errorf("deny prefix is invalid")
		}
	}
	return nil
}

func renderNginx(target TargetConfig, desired ingressDesired, tls bool) ([]byte, error) {
	if err := validateIngress(target, desired); err != nil {
		return nil, err
	}
	view := struct {
		TargetID, Hostname, AcmeWebroot, DocumentRoot string
		DenyPrefixes                                  []string
		TLS, SPAFallback, NoCache                     bool
	}{
		TargetID: target.TargetID, Hostname: target.Hostname, AcmeWebroot: target.AcmeWebroot,
		DocumentRoot: desired.DocumentRoot, DenyPrefixes: desired.DenyPrefixes, TLS: tls,
		SPAFallback: desired.SPAFallback, NoCache: desired.CachePolicy == "no-cache",
	}
	parsed, err := template.New("nginx").Parse(nginxTemplate)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := parsed.Execute(&output, view); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// proxyIngressDesired is the service counterpart of ingressDesired: nginx
// terminates TLS and forwards to the contract's loopback port; the app owns its
// own security headers (handymanservices sets them with helmet).
type proxyIngressDesired struct {
	Hostname        string `json:"hostname"`
	SecurityHeaders string `json:"securityHeaders"`
	MaxBodyMB       int    `json:"maxBodyMb"`
}

const proxyTemplate = `# managed-by: psm-host-helper/v1
# target: {{.TargetID}}
server {
    listen 80;
    listen [::]:80;
    server_name {{.Hostname}};

    location ^~ /.well-known/acme-challenge/ {
        root {{.AcmeWebroot}};
        try_files $uri =404;
    }
{{if .TLS}}
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{.Hostname}};
    ssl_certificate /etc/letsencrypt/live/{{.Hostname}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{.Hostname}}/privkey.pem;
    client_max_body_size {{.MaxBodyMB}}m;

    location / {
        proxy_pass http://127.0.0.1:{{.Port}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
{{else}}
    location / { return 404; }
{{end}}
}
`

func renderProxy(target TargetConfig, desired proxyIngressDesired, tls bool) ([]byte, error) {
	if desired.Hostname != target.Hostname {
		return nil, fmt.Errorf("ingress hostname differs from the enrolled target")
	}
	if desired.SecurityHeaders != "app-managed@1" {
		return nil, fmt.Errorf("security header profile is unsupported")
	}
	if desired.MaxBodyMB < 1 || desired.MaxBodyMB > 100 {
		return nil, fmt.Errorf("maxBodyMb must be between 1 and 100")
	}
	view := map[string]any{"TargetID": target.TargetID, "Hostname": target.Hostname, "AcmeWebroot": target.AcmeWebroot,
		"Port": target.Service.Port, "MaxBodyMB": desired.MaxBodyMB, "TLS": tls}
	parsed, err := template.New("proxy").Parse(proxyTemplate)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := parsed.Execute(&output, view); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// renderIngress picks the template the target was enrolled for.
func renderIngress(target TargetConfig, raw json.RawMessage, tls bool) ([]byte, error) {
	if target.Service != nil {
		var desired proxyIngressDesired
		if err := decodeDesired(raw, &desired); err != nil {
			return nil, err
		}
		return renderProxy(target, desired, tls)
	}
	var desired ingressDesired
	if err := decodeDesired(raw, &desired); err != nil {
		return nil, err
	}
	return renderNginx(target, desired, tls)
}
