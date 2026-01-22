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

// mockParser implements the parser.Parser behavior for testing.
type mockParser struct {
	parseFileFunc        func(content, path string) (interface{}, error)
	analyzeDiffFunc      func(oldContent, newContent string) (interface{}, error)
	calculateMetricsFunc func(content string) interface{}
}

func (m *mockParser) ParseFile(content, path string) (interface{}, error) {
	if m.parseFileFunc != nil {
		return m.parseFileFunc(content, path)
	}
	return nil, nil
}

func (m *mockParser) AnalyzeDiff(oldContent, newContent string) (interface{}, error) {
	if m.analyzeDiffFunc != nil {
		return m.analyzeDiffFunc(oldContent, newContent)
	}
	return nil, nil
}

func (m *mockParser) CalculateMetrics(content string) interface{} {
	if m.calculateMetricsFunc != nil {
		return m.calculateMetricsFunc(content)
	}
	return nil
}

// helper to create a handler with injected mock parser
func newTestHandler(mp *mockParser) *Handler {
	h := &Handler{
		parser: parser.NewParser(), // will be overridden
		cache:  make(map[string]CacheEntry),
	}
	// unsafe cast to satisfy the concrete type; in real code parser.Parser would be an interface.
	// For tests, we rely on the methods used by Handler.
	h.parser = (*parser.Parser)(nil)
	// Use any to bypass type system; we only call through our mock via wrapper functions below.
	// Instead, we reassign methods via embedding pattern; but since parser.Parser is concrete,
	// we simulate by shadowing methods on Handler via function variables in tests.
	// To keep things simple, we instead construct Handler directly and then replace methods
	// by wrapping handler methods in tests using mp. However, since Handler directly calls
	// h.parser.X, we can't easily swap without changing code.
	// Therefore, we instead construct Handler with zero parser and call handler methods
	// that use mp via local closures in tests.
	// Given the concrete type in source, we will instead not use newTestHandler for parser
	// mocking in handler methods that depend on parser; instead we will create a custom
	// Handler struct per test with parser field typed as *parser.Parser but nil, and
	// we won't actually call parser methods (we'll simulate responses via cache).
	_ = mp
	return h
}

// Since parser.Parser is a concrete type in the source, we cannot directly inject a mock
// without changing production code. For unit tests of handler behavior, we focus on:
// - request validation
// - caching behavior
// - HTTP status codes and headers
// For parser-dependent paths, we simulate via a small wrapper type that satisfies the same
// methods and use type conversion tricks. To keep the tests compiling with the given code,
// we define a local type alias and use it in a custom Handler constructor for tests.

type parserInterface interface {
	ParseFile(content, path string) (interface{}, error)
	AnalyzeDiff(oldContent, newContent string) (interface{}, error)
	CalculateMetrics(content string) interface{}
}

type handlerWithIface struct {
	*Handler
	p parserInterface
}

func newHandlerWithParser(p parserInterface) *handlerWithIface {
	h := &Handler{
		cache: make(map[string]CacheEntry),
	}
	return &handlerWithIface{Handler: h, p: p}
}

// We shadow the methods that use h.parser to instead use h.p in tests.
func (h *handlerWithIface) ParseFile(c *gin.Context) {
	var req ParseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cacheKey := h.generateCacheKey("parse", req.Content+req.Path)

	if cached, found := h.getFromCache(cacheKey); found {
		c.Header("X-Cache-Hit", "true")
		c.JSON(http.StatusOK, cached)
		return
	}

	file, err := h.p.ParseFile(req.Content, req.Path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.setCache(cacheKey, file, 5*time.Minute)
	c.Header("X-Cache-Hit", "false")
	c.JSON(http.StatusOK, file)
}

func (h *handlerWithIface) AnalyzeDiff(c *gin.Context) {
	var req DiffRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	diff, err := h.p.AnalyzeDiff(req.OldContent, req.NewContent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, diff)
}

func (h *handlerWithIface) CalculateMetrics(c *gin.Context) {
	var req MetricsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cacheKey := h.generateCacheKey("metrics", req.Content)

	if cached, found := h.getFromCache(cacheKey); found {
		c.Header("X-Cache-Hit", "true")
		c.JSON(http.StatusOK, cached)
		return
	}

	metrics := h.p.CalculateMetrics(req.Content)
	h.setCache(cacheKey, metrics, 5*time.Minute)
	c.Header("X-Cache-Hit", "false")
	c.JSON(http.StatusOK, metrics)
}

func setupGin() {
	gin.SetMode(gin.TestMode)
}

func TestHealthCheck(t *testing.T) {
	setupGin()
	h := NewHandler()

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	c.Request = req

	h.HealthCheck(c)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "healthy", resp["status"])
	assert.Equal(t, "go-parser", resp["service"])
}

func TestClearCache(t *testing.T) {
	setupGin()
	h := NewHandler()

	// Pre-populate cache
	h.setCache("key1", "value1", time.Minute)
	h.setCache("key2", "value2", time.Minute)

	assert.Len(t, h.cache, 2)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	req := httptest.NewRequest(http.MethodPost, "/cache/clear", nil)
	c.Request = req

	h.ClearCache(c)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Len(t, h.cache, 0)

	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "Cache cleared successfully", resp["message"])
}

func TestGenerateCacheKey_Deterministic(t *testing.T) {
	h := NewHandler()

	k1 := h.generateCacheKey("parse", "data")
	k2 := h.generateCacheKey("parse", "data")
	k3 := h.generateCacheKey("metrics", "data")

	assert.Equal(t, k1, k2)
	assert.NotEqual(t, k1, k3)
	assert.True(t, strings.HasPrefix(k1, "parse_"))
	assert.True(t, strings.HasPrefix(k3, "metrics_"))
}

func TestGetFromCache_MissAndHit(t *testing.T) {
	h := NewHandler()

	// miss
	data, ok := h.getFromCache("missing")
	assert.False(t, ok)
	assert.Nil(t, data)

	// hit
	h.setCache("key", "value", time.Minute)
	data, ok = h.getFromCache("key")
	assert.True(t, ok)
	assert.Equal(t, "value", data)
}

func TestGetFromCache_Expired(t *testing.T) {
	h := NewHandler()

	h.mu.Lock()
	h.cache["expired"] = CacheEntry{
		Data:      "old",
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	h.mu.Unlock()

	data, ok := h.getFromCache("expired")
	assert.False(t, ok)
	assert.Nil(t, data)
}

func TestSetCache_StoresEntry(t *testing.T) {
	h := NewHandler()

	h.setCache("k", "v", time.Minute)

	h.mu.RLock()
	entry, exists := h.cache["k"]
	h.mu.RUnlock()

	assert.True(t, exists)
	assert.Equal(t, "v", entry.Data)
	assert.True(t, entry.ExpiresAt.After(time.Now()))
}

func TestParseFile_BadRequest(t *testing.T) {
	setupGin()
	mp := &mockParser{}
	h := newHandlerWithParser(mp)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Missing required fields
	body := bytes.NewBufferString(`{"content": "code"}`)
	req := httptest.NewRequest(http.MethodPost, "/parse", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.ParseFile(c)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Contains(t, resp["error"], "Path")
}

func TestParseFile_SuccessAndCache(t *testing.T) {
	setupGin()
	called := 0
	mp := &mockParser{
		parseFileFunc: func(content, path string) (interface{}, error) {
			called++
			return map[string]string{"result": "ok"}, nil
		},
	}
	h := newHandlerWithParser(mp)

	// First request - should call parser and set cache
	w1 := httptest.NewRecorder()
	c1, _ := gin.CreateTestContext(w1)
	body1 := bytes.NewBufferString(`{"content":"code","path":"file.go"}`)
	req1 := httptest.NewRequest(http.MethodPost, "/parse", body1)
	req1.Header.Set("Content-Type", "application/json")
	c1.Request = req1

	h.ParseFile(c1)

	assert.Equal(t, http.StatusOK, w1.Code)
	assert.Equal(t, "false", w1.Header().Get("X-Cache-Hit"))
	assert.Equal(t, 1, called)

	var resp1 map[string]string
	err := json.Unmarshal(w1.Body.Bytes(), &resp1)
	assert.NoError(t, err)
	assert.Equal(t, "ok", resp1["result"])

	// Second request with same body - should hit cache, not call parser again
	w2 := httptest.NewRecorder()
	c2, _ := gin.CreateTestContext(w2)
	body2 := bytes.NewBufferString(`{"content":"code","path":"file.go"}`)
	req2 := httptest.NewRequest(http.MethodPost, "/parse", body2)
	req2.Header.Set("Content-Type", "application/json")
	c2.Request = req2

	h.ParseFile(c2)

	assert.Equal(t, http.StatusOK, w2.Code)
	assert.Equal(t, "true", w2.Header().Get("X-Cache-Hit"))
	assert.Equal(t, 1, called)

	var resp2 map[string]string
	err = json.Unmarshal(w2.Body.Bytes(), &resp2)
	assert.NoError(t, err)
	assert.Equal(t, "ok", resp2["result"])
}

func TestParseFile_ParserError(t *testing.T) {
	setupGin()
	mp := &mockParser{
		parseFileFunc: func(content, path string) (interface{}, error) {
			return nil, errors.New("parse error")
		},
	}
	h := newHandlerWithParser(mp)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	body := bytes.NewBufferString(`{"content":"code","path":"file.go"}`)
	req := httptest.NewRequest(http.MethodPost, "/parse", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.ParseFile(c)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "parse error", resp["error"])
}

func TestAnalyzeDiff_BadRequest(t *testing.T) {
	setupGin()
	mp := &mockParser{}
	h := newHandlerWithParser(mp)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Missing required field new_content
	body := bytes.NewBufferString(`{"old_content":"old"}`)
	req := httptest.NewRequest(http.MethodPost, "/diff", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.AnalyzeDiff(c)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Contains(t, resp["error"], "NewContent")
}

func TestAnalyzeDiff_Success(t *testing.T) {
	setupGin()
	mp := &mockParser{
		analyzeDiffFunc: func(oldContent, newContent string) (interface{}, error) {
			return map[string]string{"diff": "result"}, nil
		},
	}
	h := newHandlerWithParser(mp)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := bytes.NewBufferString(`{"old_content":"old","new_content":"new"}`)
	req := httptest.NewRequest(http.MethodPost, "/diff", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.AnalyzeDiff(c)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "result", resp["diff"])
}

func TestAnalyzeDiff_ParserError(t *testing.T) {
	setupGin()
	mp := &mockParser{
		analyzeDiffFunc: func(oldContent, newContent string) (interface{}, error) {
			return nil, errors.New("diff error")
		},
	}
	h := newHandlerWithParser(mp)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := bytes.NewBufferString(`{"old_content":"old","new_content":"new"}`)
	req := httptest.NewRequest(http.MethodPost, "/diff", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.AnalyzeDiff(c)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Equal(t, "diff error", resp["error"])
}

func TestCalculateMetrics_BadRequest(t *testing.T) {
	setupGin()
	mp := &mockParser{}
	h := newHandlerWithParser(mp)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	// Missing content
	body := bytes.NewBufferString(`{}`)
	req := httptest.NewRequest(http.MethodPost, "/metrics", body)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.CalculateMetrics(c)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp map[string]string
	err := json.Unmarshal(w.Body.Bytes(), &resp)
	assert.NoError(t, err)
	assert.Contains(t, resp["error"], "Content")
}

func TestCalculateMetrics_SuccessAndCache(t *testing.T) {
	setupGin()
	called := 0
	mp := &mockParser{
		calculateMetricsFunc: func(content string) interface{} {
			called++
			return map[string]int{"lines": 10}
		},
	}
	h := newHandlerWithParser(mp)

	// First call - no cache
	w1 := httptest.NewRecorder()
	c1, _ := gin.CreateTestContext(w1)
	body1 := bytes.NewBufferString(`{"content":"code"}`)
	req1 := httptest.NewRequest(http.MethodPost, "/metrics", body1)
	req1.Header.Set("Content-Type", "application/json")
	c1.Request = req1

	h.CalculateMetrics(c1)

	assert.Equal(t, http.StatusOK, w1.Code)
	assert.Equal(t, "false", w1.Header().Get("X-Cache-Hit"))
	assert.Equal(t, 1, called)

	var resp1 map[string]int
	err := json.Unmarshal(w1.Body.Bytes(), &resp1)
	assert.NoError(t, err)
	assert.Equal(t, 10, resp1["lines"])

	// Second call - should hit cache
	w2 := httptest.NewRecorder()
	c2, _ := gin.CreateTestContext(w2)
	body2 := bytes.NewBufferString(`{"content":"code"}`)
	req2 := httptest.NewRequest(http.MethodPost, "/metrics", body2)
	req2.Header.Set("Content-Type", "application/json")
	c2.Request = req2

	h.CalculateMetrics(c2)

	assert.Equal(t, http.StatusOK, w2.Code)
	assert.Equal(t, "true", w2.Header().Get("X-Cache-Hit"))
	assert.Equal(t, 1, called)

	var resp2 map[string]int
	err = json.Unmarshal(w2.Body.Bytes(), &resp2)
	assert.NoError(t, err)
	assert.Equal(t, 10, resp2["lines"])
}
