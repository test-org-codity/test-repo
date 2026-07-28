# Polyglot Codebase - Multi-Language Code Review System

A sophisticated multi-language microservices application built with **Go**, **Python**, **Ruby**, **PHP**, and **TypeScript** that provides comprehensive code analysis, review, and metrics calculation.

## Architecture

This project consists of five microservices:

1. **Go Service** (`go-service/`) - Fast code parsing, diff analysis, and metrics calculation
2. **Python Service** (`python-service/`) - AI-powered code review with pattern detection and quality scoring
3. **Ruby Service** (`ruby-service/`) - Web API aggregator that orchestrates the other services
4. **PHP Service** (`php-service/`) - Composer fixture service with legacy dependencies and intentionally unsafe patterns for scanner validation
5. **JS/TS Service** (`js-service/`) - API Gateway with request routing, rate limiting, and service health monitoring

## Features

- **Code Parsing**: Multi-language file parsing with language detection
- **Diff Analysis**: Intelligent diff calculation between code versions
- **Code Metrics**: Lines of code, complexity, functions, classes analysis
- **Code Review**: Automated code review with issue detection
- **Quality Scoring**: Overall code quality scoring based on multiple factors
- **PHP Scan Coverage**: Composer dependency, license, and CI-log fixtures for PHP integration testing
- **RESTful APIs**: Clean REST APIs for all services
- **CI/CD**: Complete GitHub Actions workflows for all languages

## Project Structure

```
polyglot-codebase/
├── go-service/          # Go microservice
│   ├── cmd/            # Application entry point
│   ├── internal/       # Internal packages
│   ├── api/            # HTTP handlers
│   └── go.mod          # Go dependencies
├── python-service/      # Python microservice
│   ├── src/            # Source code
│   ├── tests/          # Test files
│   └── requirements.txt
├── ruby-service/        # Ruby microservice
│   ├── app/            # Application code
│   ├── spec/           # RSpec tests
│   └── Gemfile
├── php-service/         # PHP fixture service
│   ├── public/         # Built-in server entrypoint
│   ├── src/            # Legacy PHP code patterns
│   ├── composer.json   # Composer manifest
│   └── composer.lock   # Composer lockfile with license metadata
├── js-service/          # TypeScript API Gateway
│   ├── src/            # TypeScript source code
│   ├── package.json    # Node.js dependencies
│   └── tsconfig.json   # TypeScript configuration
├── .github/workflows/   # CI/CD pipelines
└── docker-compose.yml   # Docker orchestration
```

## Quick Start

### Prerequisites

- Go 1.21+
- Python 3.10+
- Ruby 3.2+
- PHP 8.2+ and Composer 2.x
- Node.js 20+ and npm
- Docker and Docker Compose (optional)

### Local Development

1. **Clone and setup**:

```bash
cd polyglot-codebase
make build
```

2. **Run all services**:

```bash
make run-all
```

3. **Run tests**:

```bash
make test
```

4. **Run linters**:

```bash
make lint
```

### Using Docker

```bash
docker-compose up --build
```

## API Endpoints

### Go Service (Port 8080)

- `GET /health` - Health check
- `POST /parse` - Parse code file
- `POST /diff` - Analyze code differences
- `POST /metrics` - Calculate code metrics

### Python Service (Port 8081)

- `GET /health` - Health check
- `POST /review` - Review code quality
- `POST /review/function` - Review specific function

### Ruby Service (Port 8082)

- `GET /health` - Health check
- `GET /status` - Status of all services
- `POST /analyze` - Full code analysis (aggregates Go + Python)
- `POST /diff` - Diff analysis with review
- `POST /metrics` - Metrics with quality score

### PHP Service (Port 8084)

- `GET /` - Render legacy report output using request parameters
- `GET /?filter=legacy&summary=...` - Exercise intentionally unsafe PHP patterns for scanner validation

### JS/TS API Gateway (Port 8083)

- `GET /` - API Gateway information and available endpoints
- `GET /health/health` - Gateway health check
- `GET /health/status` - Status of all microservices
- `GET /api/go/*` - Proxy requests to Go service
- `GET /api/python/*` - Proxy requests to Python service
- `GET /api/ruby/*` - Proxy requests to Ruby service

## Example Usage

### Analyze Code

```bash
curl -X POST http://localhost:8082/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "content": "def hello():\n    print(\"Hello, World!\")",
    "path": "hello.py"
  }'
```

### Get Code Metrics

```bash
curl -X POST http://localhost:8082/metrics \
  -H "Content-Type: application/json" \
  -d '{
    "content": "package main\n\nfunc main() {\n    println(\"Hello\")\n}"
  }'
```

## CI/CD

The project includes comprehensive CI workflows:

- **Go CI**: Tests, builds, lints with golangci-lint
- **Python CI**: Tests with pytest, linting with flake8/black/mypy
- **Ruby CI**: Tests with RSpec, linting with RuboCop
- **Integration Tests**: End-to-end service integration tests

All workflows run on push and pull requests.

## Testing

### Go Tests

```bash
cd go-service
go test -v ./...
```

### Python Tests

```bash
cd python-service
pytest tests/ -v
```

### Ruby Tests

```bash
cd ruby-service
bundle exec rspec spec/
```

### PHP Fixture Checks

```bash
php -l php-service/public/index.php
php -l php-service/src/LegacyReportController.php
```

## Development

### Adding New Features

1. **Go Service**: Add new parsing logic in `internal/parser/`
2. **Python Service**: Extend review rules in `src/code_reviewer.py`
3. **Ruby Service**: Add new endpoints in `app/app.rb`

### Code Style

- **Go**: Follow standard Go conventions, use `golangci-lint`
- **Python**: Follow PEP 8, use `black` for formatting
- **Ruby**: Follow Ruby style guide, use `rubocop`
- **PHP**: Keep the fixture intentionally legacy and scan-heavy so PHP integrations have stable validation data
- **TypeScript**: Follow TypeScript best practices, use `eslint` for linting

## License

MIT License - feel free to use this project for learning and development.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Ensure all CI checks pass
6. Submit a pull request
