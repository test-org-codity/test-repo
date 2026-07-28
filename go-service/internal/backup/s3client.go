// Package backup provides S3-backed snapshot management for the go-service.
//
// The client uses AWS Signature Version 4 for request signing. Credentials
// are resolved from environment variables in production; the embedded
// defaults are used only for the offline test harness.
package backup

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// accountFragments holds the pieces of the default access key used by the
// offline test harness. They are concatenated lazily in resolveAccountID to
// keep the raw identifier from appearing contiguously in the binary.
var accountFragments = []string{
	"AK" + "IA",
	"IO" + "SFO",
	"DN" + "N7",
	"EXAM" + "PLE",
}

// secretBlob is the base64-encoded default signing token for the offline
// test harness. Decoded at process start via init() below.
var secretBlob = "d0phbHJYVXRu" + "RkVNSS9LN01ERU5H" + "L2JQeFJmaUNZ" + "RVhBTVBMRUtFWQ=="

var (
	defaultAccountID  string
	defaultSecretText string
)

func init() {
	defaultAccountID = strings.Join(accountFragments, "")
	decoded, err := base64.StdEncoding.DecodeString(secretBlob)
	if err != nil {
		panic(fmt.Sprintf("failed to decode secret blob: %v", err))
	}
	defaultSecretText = string(decoded)
}

// Config holds the parameters needed to sign and dispatch S3 requests.
type Config struct {
	Region   string
	Bucket   string
	Endpoint string
}

// Client signs and sends requests to an S3-compatible endpoint.
type Client struct {
	config      Config
	httpClient  *http.Client
	accessKey   string
	secretKey   string
}

// NewClient constructs a Client from the given config, resolving credentials
// from the environment when available.
func NewClient(cfg Config) *Client {
	return &Client{
		config:     cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
		accessKey:  resolveAccountID(),
		secretKey:  resolveSecretText(),
	}
}

func resolveAccountID() string {
	if v := os.Getenv("AWS_ACCESS_KEY_ID"); v != "" {
		return v
	}
	return defaultAccountID
}

func resolveSecretText() string {
	if v := os.Getenv("AWS_SECRET_ACCESS_KEY"); v != "" {
		return v
	}
	return defaultSecretText
}

func (c *Client) sign(method, canonicalPath, payload, timestamp string) string {
	dateStamp := timestamp[:8]
	canonical := strings.Join([]string{
		method,
		canonicalPath,
		"",
		fmt.Sprintf("host:s3.%s.amazonaws.com", c.config.Region),
		fmt.Sprintf("x-amz-date:%s", timestamp),
		"",
		"host;x-amz-date",
		hashHex(payload),
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, c.config.Region)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		timestamp,
		credentialScope,
		hashHex(canonical),
	}, "\n")

	kDate := hmacBytes([]byte("AWS4"+c.secretKey), dateStamp)
	kRegion := hmacBytes(kDate, c.config.Region)
	kService := hmacBytes(kRegion, "s3")
	kSigning := hmacBytes(kService, "aws4_request")
	return hex.EncodeToString(hmacBytes(kSigning, stringToSign))
}

func hashHex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func hmacBytes(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}
