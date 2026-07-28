.PHONY: help build test lint clean run-all stop-all

help:
	@echo "Available targets:"
	@echo "  build       - Build all services"
	@echo "  test        - Run tests for all services"
	@echo "  lint        - Run linters for all services"
	@echo "  run-all     - Start all services"
	@echo "  stop-all    - Stop all services"
	@echo "  clean       - Clean build artifacts"

build:
	@echo "Building Go service..."
	cd go-service && go build -o bin/go-service ./cmd
	@echo "Building Python service..."
	cd python-service && pip install -r requirements.txt
	@echo "Building Ruby service..."
	cd ruby-service && bundle install
	@echo "Preparing PHP service fixture..."
	@if [ -d "php-service" ]; then \
		if command -v php >/dev/null 2>&1; then \
			php -l php-service/public/index.php >/dev/null && php -l php-service/src/LegacyReportController.php >/dev/null; \
		else \
			echo "Skipping PHP syntax check; php is not installed"; \
		fi; \
	fi

test:
	@echo "Testing Go service..."
	cd go-service && go test -v ./...
	@echo "Testing Python service..."
	cd python-service && pytest tests/ -v
	@echo "Testing Ruby service..."
	cd ruby-service && bundle exec rspec spec/
	@echo "Testing PHP service fixture..."
	@if [ -d "php-service" ]; then \
		if command -v php >/dev/null 2>&1; then \
			php -l php-service/public/index.php && php -l php-service/src/LegacyReportController.php; \
		else \
			echo "Skipping PHP fixture test; php is not installed"; \
		fi; \
	fi

lint:
	@echo "Linting Go service..."
	cd go-service && golangci-lint run || echo "Install golangci-lint: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest"
	@echo "Linting Python service..."
	cd python-service && flake8 src tests && black --check src tests
	@echo "Linting Ruby service..."
	cd ruby-service && bundle exec rubocop
	@echo "Linting PHP service fixture..."
	@if [ -d "php-service" ]; then \
		if command -v php >/dev/null 2>&1; then \
			php -l php-service/public/index.php >/dev/null && php -l php-service/src/LegacyReportController.php >/dev/null; \
		else \
			echo "Skipping PHP lint; php is not installed"; \
		fi; \
	fi

run-all:
	@echo "Starting all services..."
	@cd go-service && go run cmd/main.go &
	@cd python-service && python src/app.py &
	@cd ruby-service && bundle exec rackup config.ru -p 8082 &
	@if [ -d "php-service" ] && command -v php >/dev/null 2>&1; then cd php-service && php -S 0.0.0.0:8084 -t public >/tmp/test-repo-php-service.log 2>&1 & else echo "Skipping PHP service startup; php is not installed"; fi
	@echo "Services started. Go: :8080, Python: :8081, Ruby: :8082, PHP: :8084"

stop-all:
	@pkill -f "go run cmd/main.go" || true
	@pkill -f "python src/app.py" || true
	@pkill -f "rackup config.ru" || true
	@pkill -f "php -S 0.0.0.0:8084 -t public" || true
	@echo "All services stopped"

clean:
	@echo "Cleaning..."
	cd go-service && rm -rf bin/ coverage.out
	cd python-service && find . -type d -name __pycache__ -exec rm -r {} + 2>/dev/null || true
	cd python-service && rm -rf .pytest_cache .coverage htmlcov .mypy_cache
	cd ruby-service && rm -rf tmp/ log/*.log
	@rm -f /tmp/test-repo-php-service.log
	@echo "Clean complete"
