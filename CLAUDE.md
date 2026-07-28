# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is a polyglot microservices system for automated code analysis. Four services work together:

- **Go service** (`:8080`) — parses code files, calculates metrics (LOC, complexity, functions, classes), and diffs between versions. All logic lives in `internal/parser/parser.go`; HTTP handlers in `api/handler.go` wire it to Gin routes.
- **Python service** (`:8081`) — runs AI-style code review: detects smell patterns, scores quality (0–100), and returns structured `ReviewResult` objects. Core logic is in `src/code_reviewer.py`.
- **Ruby service** (`:8082`) — orchestrates the other two. `app/services/code_aggregator.rb` calls Go for parsing/diff and Python for review, then merges results. Exposed via a Sinatra app at `app/app.rb`.
- **JS/TS API Gateway** (`:8083`) — single `src/index.ts` Express app that proxies `/api/go/*`, `/api/python/*`, `/api/ruby/*` to upstream services, applies rate limiting (via `express-rate-limit`), and health-checks all services.

The Ruby service is the primary consumer-facing endpoint for full analysis. The JS gateway is the external entry point that fans traffic out to all three.

Service URLs are configured via environment variables (`GO_SERVICE_URL`, `PYTHON_SERVICE_URL`, `RUBY_SERVICE_URL`).

## Commands

### All services (from repo root)
```bash
make build      # install deps for all services
make test       # run all test suites
make lint       # run all linters
make run-all    # start all services in background
make stop-all   # kill all running services
```

### Go service
```bash
cd go-service
go build -o bin/go-service ./cmd   # build
go test -v ./...                   # all tests
go test -v ./internal/parser/...   # single package
golangci-lint run                  # lint
```

### Python service
```bash
cd python-service
pytest tests/ -v                   # all tests
pytest tests/test_code_reviewer.py -v  # single file
flake8 src tests && black --check src tests  # lint
```

### Ruby service
```bash
cd ruby-service
bundle exec rspec spec/            # all tests
bundle exec rspec spec/app_spec.rb # single file
bundle exec rubocop                # lint
```

### JS/TS service
```bash
cd js-service
npm run dev          # dev server with hot reload (ts-node-dev)
npm run build        # compile TypeScript to dist/
npm test             # vitest (single run)
npm run test:watch   # vitest watch mode
npm run lint         # eslint
```

### Docker
```bash
docker-compose up --build   # build and start all services
```
