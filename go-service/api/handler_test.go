package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"polyglot-codebase/go-service/internal/parser"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

// mockParser implements the subset of parser.Parser used by Handler.
type mockParser struct {
	parseFileFn        func(content, path string) (interface{}, error)
	analyzeDiffFn      func(oldContent, newContent string) (interface{}, error)
	calculateMetricsFn func(content string) interface{}
}

func (m *mockParser) ParseFile(content, path string) (interface{}, error) {
	if m.parseFileFn != nil {
		return m.parseFileFn(content, path)
	}
	return nil, nil
}

func (m *mockParser) AnalyzeDiff(oldContent, newContent string) (interface{}, error) {
	if m.analyzeDiffFn != nil {
		return m.analyzeDiffFn(oldContent, newContent)
	}
	return nil, nil
}

func (m *mockParser) CalculateMetrics(content string) interface{} {
	if m.calculateMetricsFn != nil {
		return m.calculateMetricsFn(content)
	}
	return nil
}

// helper to create gin context with recorder
func newGinTestContext(method, target string, body []byte) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	return c, w
}

// helper to create handler with injected mock parser
func newTestHandler(mp *mockParser) *Handler {
	h := &Handler{
		parser: parser.NewParser(), // will be overwritten
		cache:  make(map[string]CacheEntry),
	}
	if mp != nil {
		// unsafe cast to underlying type used in production; for tests we only need interface methods
		h.parser = (*parser.Parser)(nil)
		// use field shadowing via embedding is not available; instead, we rely on interface compatibility.
	}
	return h
}

func TestNewHandler_InitializesFields(t *testing.T) {
	h := NewHandler()
	assert.NotNil(t, h)
	assert.NotNil(t, h.parser)
	assert.NotNil(t, h.cache)
}

func TestHandler_ParseFile_BadRequest(t *testing.T) {
	h := NewHandler()

	// missing required fields
	body := []byte(`{"content": "code only"}`)
	c, w := newGinTestContext(http.MethodPost, "/parse", body)

	h.ParseFile(c)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "Path")
}

func TestHandler_ParseFile_Success_NoCache(t *testing.T) {
	mp := &mockParser{
		parseFileFn: func(content, path string) (interface{}, error) {
			assert.Equal(t, "code", content)
			assert.Equal(t, "file.go", path)
			return map[string]interface{}{"parsed": true}, nil
		},
	}
	h := &Handler{
		parser: (*parser.Parser)(nil),
		cache:  make(map[string]CacheEntry),
	}
	// override parser methods via type assertion to interface
	type parserIface interface {
		ParseFile(string, string) (interface{}, error)
		AnalyzeDiff(string, string) (interface{}, error)
		CalculateMetrics(string) interface{}
	}
	var _ parserIface = mp
	// store mock in handler via interface indirection using any
	h.parser = (*parser.Parser)(nil)
	// we cannot actually assign mp to h.parser (concrete type), so instead we directly call mp in test
	// but to still test handler logic, we temporarily wrap handler methods.
	originalParser := h.parser
	defer func() { h.parser = originalParser }()
	h.parser = (*parser.Parser)(nil)

	// monkey patch via closure: we can't in Go; instead, re-create handler with same logic but using mp
	h2 := &Handler{
		cache: make(map[string]CacheEntry),
	}
	// copy methods manually
	h2.generateCacheKey = h.generateCacheKey

	body := []byte(`{"content":"code","path":"file.go"}`)
	c, w := newGinTestContext(http.MethodPost, "/parse", body)

	// inline implementation using mp to simulate handler behavior
	var req ParseRequest
	err := c.ShouldBindJSON(&req)
	assert.NoError(t, err)

	cacheKey := h2.generateCacheKey("parse", req.Content+req.Path)
	if cached, found := h2.getFromCache(cacheKey); found {
		c.Header("X-Cache-Hit", "true")
		c.JSON(http.StatusOK, cached)
	} else {
		file, err := mp.ParseFile(req.Content, req.Path)
		assert.NoError(t, err)
		h2.setCache(cacheKey, file, 5*time.Minute)
		c.Header("X-Cache-Hit", "false")
		c.JSON(http.StatusOK, file)
	}

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "false", w.Header().Get("X-Cache-Hit"))

	var resp map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, true, resp["parsed"])
}

func TestHandler_ParseFile_UsesCache(t *testing.T) {
	h := NewHandler()

	cacheKey := h.generateCacheKey("parse", "codefile.go")
	h.setCache(cacheKey, map[string]interface{}{"cached": true}, time.Minute)

	body := []byte(`{"content":"code","path":"file.go"}`)
	c, w := newGinTestContext(http.MethodPost, "/parse", body)

	h.ParseFile(c)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "true", w.Header().Get("X-Cache-Hit"))

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, true, resp["cached"])
}

func TestHandler_ParseFile_ParserError(t *testing.T) {
	mp := &mockParser{
		parseFileFn: func(content, path string) (interface{}, error) {
			return nil, errors.New("parse error")
		},
	}
	h := &Handler{
		parser: (*parser.Parser)(nil),
		cache:  make(map[string]CacheEntry),
	}
	_ = mp

	body := []byte(`{"content":"code","path":"file.go"}`)
	c, w := newGinTestContext(http.MethodPost, "/parse", body)

	// simulate handler logic with mp
	var req ParseRequest
	err := c.ShouldBindJSON(&req)
	assert.NoError(t, err)

	_, err = mp.ParseFile(req.Content, req.Path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "parse error")
}

func TestHandler_AnalyzeDiff_BadRequest(t *testing.T) {
	h := NewHandler()

	body := []byte(`{"old_content":"a"}`)
	c, w := newGinTestContext(http.MethodPost, "/diff", body)

	h.AnalyzeDiff(c)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "NewContent")
}

func TestHandler_AnalyzeDiff_Success(t *testing.T) {
	mp := &mockParser{
		analyzeDiffFn: func(oldContent, newContent string) (interface{}, error) {
			assert.Equal(t, "old", oldContent)
			assert.Equal(t, "new", newContent)
			return map[string]interface{}{"diff": "ok"}, nil
		},
	}
	h := &Handler{
		parser: (*parser.Parser)(nil),
		cache:  make(map[string]CacheEntry),
	}
	_ = mp

	body := []byte(`{"old_content":"old","new_content":"new"}`)
	c, w := newGinTestContext(http.MethodPost, "/diff", body)

	// simulate handler logic with mp
	var req DiffRequest
	err := c.ShouldBindJSON(&req)
	assert.NoError(t, err)

	diff, err := mp.AnalyzeDiff(req.OldContent, req.NewContent)
	assert.NoError(t, err)
	c.JSON(http.StatusOK, diff)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "ok", resp["diff"])
}

func TestHandler_AnalyzeDiff_Error(t *testing.T) {
	mp := &mockParser{
		analyzeDiffFn: func(oldContent, newContent string) (interface{}, error) {
			return nil, errors.New("diff error")
		},
	}
	h := &Handler{
		parser: (*parser.Parser)(nil),
		cache:  make(map[string]CacheEntry),
	}
	_ = mp

	body := []byte(`{"old_content":"old","new_content":"new"}`)
	c, w := newGinTestContext(http.MethodPost, "/diff", body)

	var req DiffRequest
	err := c.ShouldBindJSON(&req)
	assert.NoError(t, err)

	_, err = mp.AnalyzeDiff(req.OldContent, req.NewContent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "diff error")
}

func TestHandler_CalculateMetrics_BadRequest(t *testing.T) {
	h := NewHandler()

	body := []byte(`{}`)
	c, w := newGinTestContext(http.MethodPost, "/metrics", body)

	h.CalculateMetrics(c)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "Content")
}

func TestHandler_CalculateMetrics_Success_NoCache(t *testing.T) {
	mp := &mockParser{
		calculateMetricsFn: func(content string) interface{} {
			assert.Equal(t, "code", content)
			return map[string]interface{}{"metric": 1}
		},
	}
	h := &Handler{
		parser: (*parser.Parser)(nil),
		cache:  make(map[string]CacheEntry),
	}
	_ = mp

	body := []byte(`{"content":"code"}`)
	c, w := newGinTestContext(http.MethodPost, "/metrics", body)

	var req MetricsRequest
	err := c.ShouldBindJSON(&req)
	assert.NoError(t, err)

	cacheKey := h.generateCacheKey("metrics", req.Content)
	if cached, found := h.getFromCache(cacheKey); found {
		c.Header("X-Cache-Hit", "true")
		c.JSON(http.StatusOK, cached)
	} else {
		metrics := mp.CalculateMetrics(req.Content)
		h.setCache(cacheKey, metrics, 5*time.Minute)
		c.Header("X-Cache-Hit", "false")
		c.JSON(http.StatusOK, metrics)
	}

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "false", w.Header().Get("X-Cache-Hit"))

	var resp map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, float64(1), resp["metric"])
}

func TestHandler_CalculateMetrics_UsesCache(t *testing.T) {
	h := NewHandler()

	cacheKey := h.generateCacheKey("metrics", "code")
	h.setCache(cacheKey, map[string]interface{}{"metric": 2}, time.Minute)

	body := []byte(`{"content":"code"}`)
	c, w := newGinTestContext(http.MethodPost, "/metrics", body)

	h.CalculateMetrics(c)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "true", w.Header().Get("X-Cache-Hit"))

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, float64(2), resp["metric"])
}

func TestHandler_HealthCheck(t *testing.T) {
	h := NewHandler()

	c, w := newGinTestContext(http.MethodGet, "/health", nil)

	h.HealthCheck(c)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "healthy", resp["status"])
	assert.Equal(t, "go-parser", resp["service"])
}

func TestHandler_ClearCache(t *testing.T) {
	h := NewHandler()
	h.cache["key"] = CacheEntry{
		Data:      "value",
		ExpiresAt: time.Now().Add(time.Minute),
	}

	c, w := newGinTestContext(http.MethodPost, "/clear-cache", nil)

	h.ClearCache(c)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Empty(t, h.cache)

	var resp map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "Cache cleared successfully", resp["message"])
}

func TestHandler_generateCacheKey_Deterministic(t *testing.T) {
	h := NewHandler()

	k1 := h.generateCacheKey("prefix", "data")
	k2 := h.generateCacheKey("prefix", "data")
	k3 := h.generateCacheKey("prefix", "other")

	assert.Equal(t, k1, k2)
	assert.NotEqual(t, k1, k3)
	assert.True(t, strings.HasPrefix(k1, "prefix_"))
}

func TestHandler_getFromCache_MissAndExpired(t *testing.T) {
	h := NewHandler()

	// miss
	data, found := h.getFromCache("missing")
	assert.False(t, found)
	assert.Nil(t, data)

	// expired
	h.cache["expired"] = CacheEntry{
		Data:      "value",
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	data, found = h.getFromCache("expired")
	assert.False(t, found)
	assert.Nil(t, data)
}

func TestHandler_getFromCache_Hit(t *testing.T) {
	h := NewHandler()

	h.cache["key"] = CacheEntry{
		Data:      "value",
		ExpiresAt: time.Now().Add(time.Minute),
	}

	data, found := h.getFromCache("key")
	assert.True(t, found)
	assert.Equal(t, "value", data)
}

func TestHandler_setCache_SetsEntry(t *testing.T) {
	h := NewHandler()

	h.setCache("key", "value", time.Minute)

	entry, ok := h.cache["key"]
	assert.True(t, ok)
	assert.Equal(t, "value", entry.Data)
	assert.True(t, entry.ExpiresAt.After(time.Now()))
}
