package main

import (
	"bytes"
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
