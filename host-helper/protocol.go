package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	requestSchema  = "psm.werewolf.solutions/host-helper-request/v1"
	responseSchema = "psm.werewolf.solutions/host-helper-response/v1"
	maxHeaderBytes = 256 * 1024
	maxResultBytes = 512 * 1024
)

type Request struct {
	Schema         string          `json:"schema"`
	RequestID      string          `json:"requestId"`
	TargetID       string          `json:"targetId"`
	Operation      string          `json:"operation"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	PlanDigest     string          `json:"planDigest,omitempty"`
	ExpiresAt      string          `json:"expiresAt,omitempty"`
	ArchiveBytes   int64           `json:"archiveBytes,omitempty"`
	Desired        json.RawMessage `json:"desired"`
}

type Response struct {
	Schema     string `json:"schema"`
	RequestID  string `json:"requestId"`
	TargetID   string `json:"targetId"`
	Operation  string `json:"operation"`
	Outcome    string `json:"outcome"`
	Code       string `json:"code"`
	Detail     string `json:"detail"`
	ObservedAt string `json:"observedAt"`
	Data       any    `json:"data,omitempty"`
}

func decodeStrict(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains more than one value")
	}
	return nil
}

func readFrame(reader io.Reader) (Request, io.Reader, error) {
	var size uint32
	if err := binary.Read(reader, binary.BigEndian, &size); err != nil {
		return Request{}, nil, fmt.Errorf("read request header size: %w", err)
	}
	if size == 0 || size > maxHeaderBytes {
		return Request{}, nil, errors.New("request header size is invalid")
	}
	raw := make([]byte, size)
	if _, err := io.ReadFull(reader, raw); err != nil {
		return Request{}, nil, fmt.Errorf("read request header: %w", err)
	}
	var request Request
	if err := decodeStrict(raw, &request); err != nil {
		return Request{}, nil, fmt.Errorf("decode request: %w", err)
	}
	if request.Schema != requestSchema {
		return Request{}, nil, errors.New("request schema is unsupported")
	}
	if request.ArchiveBytes < 0 || request.ArchiveBytes > 2*1024*1024*1024 {
		return Request{}, nil, errors.New("archive size is outside the helper limit")
	}
	return request, io.LimitReader(reader, request.ArchiveBytes), nil
}

func writeFrame(writer io.Writer, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > maxResultBytes {
		return errors.New("response exceeds the helper limit")
	}
	if err := binary.Write(writer, binary.BigEndian, uint32(len(raw))); err != nil {
		return err
	}
	_, err = writer.Write(raw)
	return err
}
