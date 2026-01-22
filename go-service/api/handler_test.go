package api

import (
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
	"github.com/stretchr/testify/mock"
)

type mockParser struct {
	mock.Mock
}

func (m *mockParser) ParseFile(content, path string) (interface{}, error) {
	args := m.Called(content, path)
	return args.Get(0), args.Error(1)
}

func (m *mockParser) AnalyzeDiff(oldContent, newContent string) (interface{}, error) {
	args := m.Called(oldContent, newContent)
	return args.Get(0), args.Error(1)
}

func (m *mockParser) CalculateMetrics(content string) interface{} {
	args := m.Called(content)
	return args.Get(0)
}

func newTestHandler() *Handler {
	h := &Handler{
		parser: parser.NewParser(),
		cache:  make(map[string]CacheEntry),
	}
	return h
}

type testParserInterface interface {
	ParseFile(content, path string) (interface{}, error)
	AnalyzeDiff(oldContent, newContent string) (interface{}, error)
	CalculateMetrics(content string) interface{}
}

type handlerWithMockParser struct {
	*Handler
	mock testParserInterface
}

func newHandlerWithMock(p testParserInterface) *handlerWithMockParser {
	h := &Handler{
		cache: make(map[string]CacheEntry),
	}
	return &handlerWithMockParser{
		Handler: h,
		mock:    p,
	}
}

func (h *handlerWithMockParser) ParseFile(c *gin.Context) {
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

	file, err := h.mock.ParseFile(req.Content, req.Path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.setCache(cacheKey, file, 5*time.Minute)
	c.Header("X-Cache-Hit", "false")
	c.JSON(http.StatusOK, file)
}

func (h *handlerWithMockParser) AnalyzeDiff(c *gin.Context) {
	var req DiffRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	diff, err := h.mock.AnalyzeDiff(req.OldContent, req.NewContent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, diff)
}

func (h *handlerWithMockParser) CalculateMetrics(c *gin.Context) {
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

	metrics := h.mock.CalculateMetrics(req.Content)
	h.setCache(cacheKey, metrics, 5*time.Minute)
	c.Header("X-Cache-Hit", "false")
	c.JSON(http.StatusOK, metrics)
}

func TestParseFile_Scenarios(t *testing.T) {
	gin.SetMode(gin.TestMode)

	mockP := new(mockParser)
	h := newHandlerWithMock(mockP)

	type parsedResult struct {
		Value string `json:"value"`
	}

	tests := []struct {
		name           string
		body           string
		setupMock      func()
		expectedStatus int
		expectCacheHit string
	}{
		{
			name:           "invalid JSON body - missing fields",
			body:           `{"content": "code only"}`,
			setupMock:      func() {},
			expectedStatus: http.StatusBadRequest,
			expectCacheHit: "",
		},
		{
			name: "parser error",
			body: `{"content": "code", "path": "file.go"}`,
			setupMock: func() {
				mockP.ExpectedCalls = nil
				mockP.On("ParseFile", "code", "file.go").Return(nil, errors.New("parse error"))
			},
			expectedStatus: http.StatusInternalServerError,
			expectCacheHit: "",
		},
		{
			name: "success no cache",
			body: `{"content": "code", "path": "file.go"}`,
			setupMock: func() {
				mockP.ExpectedCalls = nil
				mockP.On("ParseFile", "code", "file.go").Return(parsedResult{Value: "ok"}, nil)
			},
			expectedStatus: http.StatusOK,
			expectCacheHit: "false",
		},
		{
			name: "success with cache hit",
			body: `{"content": "code", "path": "file.go"}`,
			setupMock: func() {
				key := h.generateCacheKey("parse", "code"+"file.go")
				h.setCache(key, parsedResult{Value: "cached"}, 5*time.Minute)
			},
			expectedStatus: http.StatusOK,
			expectCacheHit: "true",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockP.ExpectedCalls = nil
			tt.setupMock()

			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/parse", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			c.Request = req

			h.ParseFile(c)

			assert.Equal(t, tt.expectedStatus, w.Code)

			if tt.expectedStatus == http.StatusOK {
				if tt.expectCacheHit != "" {
					assert.Equal(t, tt.expectCacheHit, w.Header().Get("X-Cache-Hit"))
				}
				var res parsedResult
				err := json.Unmarshal(w.Body.Bytes(), &res)
				assert.NoError(t, err)
			}
		})
	}
	mockP.AssertExpectations(t)
}

func TestAnalyzeDiff_Scenarios(t *testing.T) {
	gin.SetMode(gin.TestMode)

	mockP := new(mockParser)
	h := newHandlerWithMock(mockP)

	type diffResult struct {
		Changes int `json:"changes"`
	}

	tests := []struct {
		name           string
		body           string
		setupMock      func()
		expectedStatus int
	}{
		{
			name:           "invalid body",
			body:           `{"old_content": "a"}`,
			setupMock:      func() {},
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "parser error",
			body: `{"old_content": "a", "new_content": "b"}`,
			setupMock: func() {
				mockP.ExpectedCalls = nil
				mockP.On("AnalyzeDiff", "a", "b").Return(nil, errors.New("diff error"))
			},
			expectedStatus: http.StatusInternalServerError,
		},
		{
			name: "success",
			body: `{"old_content": "a", "new_content": "b"}`,
			setupMock: func() {
				mockP.ExpectedCalls = nil
				mockP.On("AnalyzeDiff", "a", "b").Return(diffResult{Changes: 1}, nil)
			},
			expectedStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockP.ExpectedCalls = nil
			tt.setupMock()

			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/diff", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			c.Request = req

			h.AnalyzeDiff(c)

			assert.Equal(t, tt.expectedStatus, w.Code)
			if tt.expectedStatus == http.StatusOK {
				var res diffResult
				err := json.Unmarshal(w.Body.Bytes(), &res)
				assert.NoError(t, err)
			}
		})
	}
	mockP.AssertExpectations(t)
}

func TestCalculateMetrics_ScenariosAndCache(t *testing.T) {
	gin.SetMode(gin.TestMode)

	mockP := new(mockParser)
	h := newHandlerWithMock(mockP)

	type metricsResult struct {
		Lines int `json:"lines"`
	}

	tests := []struct {
		name           string
		body           string
		setupMock      func()
		expectedStatus int
		expectCacheHit string
	}{
		{
			name:           "invalid body",
			body:           `{}`,
			setupMock:      func() {},
			expectedStatus: http.StatusBadRequest,
			expectCacheHit: "",
		},
		{
			name: "success no cache",
			body: `{"content": "code"}`,
			setupMock: func() {
				mockP.ExpectedCalls = nil
				mockP.On("CalculateMetrics", "code").Return(metricsResult{Lines: 1})
			},
			expectedStatus: http.StatusOK,
			expectCacheHit: "false",
		},
		{
			name: "success with cache hit",
			body: `{"content": "code"}`,
			setupMock: func() {
				key := h.generateCacheKey("metrics", "code")
				h.setCache(key, metricsResult{Lines: 2}, 5*time.Minute)
			},
			expectedStatus: http.StatusOK,
			expectCacheHit: "true",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockP.ExpectedCalls = nil
			tt.setupMock()

			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/metrics", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			c.Request = req

			h.CalculateMetrics(c)

			assert.Equal(t, tt.expectedStatus, w.Code)
			if tt.expectedStatus == http.StatusOK {
				if tt.expectCacheHit != "" {
					assert.Equal(t, tt.expectCacheHit, w.Header().Get("X-Cache-Hit"))
				}
				var res metricsResult
				err := json.Unmarshal(w.Body.Bytes(), &res)
				assert.NoError(t, err)
			}
		})
	}
	mockP.AssertExpectations(t)
}

func TestHealthCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := &Handler{
		cache: make(map[string]CacheEntry),
	}

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
	h := &Handler{
		cache: make(map[string]CacheEntry),
	}

	key1 := h.generateCacheKey("parse", "data")
	key2 := h.generateCacheKey("parse", "data")
	key3 := h.generateCacheKey("metrics", "data")

	assert.Equal(t, key1, key2)
	assert.NotEqual(t, key1, key3)
	assert.True(t, strings.HasPrefix(key1, "parse_"))
	assert.True(t, strings.HasPrefix(key3, "metrics_"))
}

func TestGetFromCache_ExpiredAndNonexistent(t *testing.T) {
	h := &Handler{
		cache: make(map[string]CacheEntry),
	}

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
	h := &Handler{
		cache: make(map[string]CacheEntry),
	}

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

	h := &Handler{
		cache: make(map[string]CacheEntry),
	}
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
