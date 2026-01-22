package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestParseFile_Scenarios(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHandler()

	type parsedResult struct {
		// actual parser.ParseFile return type is parser.File (struct with many fields),
		// but for this handler test we only need to ensure JSON is returned with 200/500/400.
	}

	tests := []struct {
		name           string
		body           string
		expectedStatus int
		expectCacheHit string
	}{
		{
			name:           "invalid JSON body - missing fields",
			body:           `{"content": "code only"}`,
			expectedStatus: http.StatusBadRequest,
			expectCacheHit: "",
		},
		{
			name:           "valid request - expects 200",
			body:           `{"content": "package main\nfunc main() {}", "path": "file.go"}`,
			expectedStatus: http.StatusOK,
			expectCacheHit: "false",
		},
		{
			name:           "second identical request - served from cache",
			body:           `{"content": "package main\nfunc main() {}", "path": "file.go"}`,
			expectedStatus: http.StatusOK,
			expectCacheHit: "true",
		},
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/parse", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			c.Request = req

			h.ParseFile(c)

			assert.Equal(t, tt.expectedStatus, w.Code)

			if tt.expectedStatus == http.StatusOK {
				if tt.expectCacheHit != "" {
					// first successful call should be cache miss, second should be hit
					if i == 1 {
						assert.Equal(t, "false", w.Header().Get("X-Cache-Hit"))
					} else if i == 2 {
						assert.Equal(t, "true", w.Header().Get("X-Cache-Hit"))
					}
				}
				var res map[string]interface{}
				err := json.Unmarshal(w.Body.Bytes(), &res)
				assert.NoError(t, err)
			}
		})
	}
}

func TestAnalyzeDiff_Scenarios(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHandler()

	tests := []struct {
		name           string
		body           string
		expectedStatus int
	}{
		{
			name:           "invalid body - missing new_content",
			body:           `{"old_content": "a"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "invalid body - missing old_content",
			body:           `{"new_content": "b"}`,
			expectedStatus: http.StatusBadRequest,
		},
		{
			name:           "success",
			body:           `{"old_content": "a", "new_content": "b"}`,
			expectedStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {

			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/diff", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			c.Request = req

			h.AnalyzeDiff(c)

			assert.Equal(t, tt.expectedStatus, w.Code)
			if tt.expectedStatus == http.StatusOK {
				var res map[string]interface{}
				err := json.Unmarshal(w.Body.Bytes(), &res)
				assert.NoError(t, err)
			}
		})
	}
}

func TestCalculateMetrics_ScenariosAndCache(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHandler()

	tests := []struct {
		name           string
		body           string
		expectedStatus int
		expectCacheHit string
	}{
		{
			name:           "invalid body - missing content",
			body:           `{}`,
			expectedStatus: http.StatusBadRequest,
			expectCacheHit: "",
		},
		{
			name:           "success no cache",
			body:           `{"content": "line1\nline2"}`,
			expectedStatus: http.StatusOK,
			expectCacheHit: "false",
		},
		{
			name:           "success with cache hit",
			body:           `{"content": "line1\nline2"}`,
			expectedStatus: http.StatusOK,
			expectCacheHit: "true",
		},
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {

			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/metrics", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			c.Request = req

			h.CalculateMetrics(c)

			assert.Equal(t, tt.expectedStatus, w.Code)
			if tt.expectedStatus == http.StatusOK {
				if tt.expectCacheHit != "" {
					if i == 1 {
						assert.Equal(t, "false", w.Header().Get("X-Cache-Hit"))
					} else if i == 2 {
						assert.Equal(t, "true", w.Header().Get("X-Cache-Hit"))
					}
				}
				var res map[string]interface{}
				err := json.Unmarshal(w.Body.Bytes(), &res)
				assert.NoError(t, err)
			}
		})
	}
}

func TestHealthCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHandler()

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	c.Request = req

	h.HealthCheck(c)

	assert.Equal(t, http.StatusOK, w.Code)
	var body map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &body)
	assert.NoError(t, err)
	assert.Equal(t, "healthy", body["status"])
	assert.Equal(t, "go-parser", body["service"])
}

func TestGenerateCacheKey_DeterministicAndDifferentPrefixes(t *testing.T) {
	h := NewHandler()

	key1 := h.generateCacheKey("parse", "data")
	key2 := h.generateCacheKey("parse", "data")
	key3 := h.generateCacheKey("metrics", "data")

	assert.Equal(t, key1, key2)
	assert.NotEqual(t, key1, key3)
	assert.True(t, strings.HasPrefix(key1, "parse_"))
	assert.True(t, strings.HasPrefix(key3, "metrics_"))
}

func TestGetFromCache_ExpiredAndNonexistent(t *testing.T) {
	h := NewHandler()

	data, ok := h.getFromCache("missing")
	assert.False(t, ok)
	assert.Nil(t, data)

	h.cache["expired"] = CacheEntry{
		Data:      "value",
		ExpiresAt: time.Now().Add(-1 * time.Minute),
	}

	data, ok = h.getFromCache("expired")
	assert.False(t, ok)
	assert.Nil(t, data)

	h.cache["valid"] = CacheEntry{
		Data:      "value",
		ExpiresAt: time.Now().Add(1 * time.Minute),
	}

	data, ok = h.getFromCache("valid")
	assert.True(t, ok)
	assert.Equal(t, "value", data)
}

func TestSetCache_StoresValue(t *testing.T) {
	h := NewHandler()

	h.setCache("key", "val", time.Minute)

	h.mu.RLock()
	entry, exists := h.cache["key"]
	h.mu.RUnlock()

	assert.True(t, exists)
	assert.Equal(t, "val", entry.Data)
	assert.WithinDuration(t, time.Now().Add(time.Minute), entry.ExpiresAt, 2*time.Second)
}

func TestClearCache_Handler(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewHandler()
	h.cache["k1"] = CacheEntry{Data: "v1", ExpiresAt: time.Now().Add(time.Minute)}

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	req := httptest.NewRequest(http.MethodDelete, "/cache", nil)
	c.Request = req

	h.ClearCache(c)

	assert.Equal(t, http.StatusOK, w.Code)
	h.mu.RLock()
	defer h.mu.RUnlock()
	assert.Empty(t, h.cache)

	var body map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &body)
	assert.NoError(t, err)
	assert.Equal(t, "Cache cleared successfully", body["message"])
}
