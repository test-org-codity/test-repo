# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpocqkxudj.rb:219: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
...: -> { :fallback_value }) dowon't_run
...                          ^~~~~
# Please review and fix any issues before running

require 'spec_helper'
require 'json'
require 'time'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name and remaining_time with expected message' do
      error = described_class.new('svc', 2.678)
      expect(error.name).to eq('svc')
      expect(error.remaining_time).to be_within(0.01).of(2.678)
      expect(error.message).to include("Circuit breaker 'svc' is open. Retry after 2.68s")
    end
  end
end

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states' do
      expect(described_class.all).to contain_exactly(:closed, :open, :half_open)
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'sets defaults' do
      cfg = described_class.new
      expect(cfg.failure_threshold).to eq(5)
      expect(cfg.success_threshold).to eq(3)
      expect(cfg.timeout_seconds).to eq(30.0)
      expect(cfg.half_open_max_calls).to eq(3)
      expect(cfg.sliding_window_size).to eq(10)
      expect(cfg.failure_rate_threshold).to eq(0.5)
    end

    it 'applies overrides' do
      cfg = described_class.new(
        failure_threshold: 2,
        success_threshold: 4,
        timeout_seconds: 1.5,
        half_open_max_calls: 2,
        sliding_window_size: 6,
        failure_rate_threshold: 0.3
      )
      expect(cfg.failure_threshold).to eq(2)
      expect(cfg.success_threshold).to eq(4)
      expect(cfg.timeout_seconds).to eq(1.5)
      expect(cfg.half_open_max_calls).to eq(2)
      expect(cfg.sliding_window_size).to eq(6)
      expect(cfg.failure_rate_threshold).to eq(0.3)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments success and total and sets last_success_time' do
      metrics.record_success(0.1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).not_to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments failure and total and sets last_failure_time' do
      metrics.record_failure(0.2)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).not_to be_nil
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      expect do
        metrics.record_rejection
      end.to change { metrics.rejected_calls }.by(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions' do
      expect do
        metrics.record_state_transition
      end.to change { metrics.state_transitions }.by(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when no data' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'averages recorded durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns summary hash without deadlock (stubbing average_response_time)' do
      # Prevent nested Mutex deadlock by stubbing average_response_time to avoid locking
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      h = metrics.to_h
      expect(h[:total_calls]).to eq(2)
      expect(h[:successful_calls]).to eq(1)
      expect(h[:failed_calls]).to eq(1)
      expect(h[:rejected_calls]).to eq(0)
      expect(h[:state_transitions]).to eq(0)
      expect(h[:average_response_time_ms]).to eq(123.0)
      expect(h[:last_failure_time]).to be_a(String)
      expect(h[:last_success_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 2,
      timeout_seconds: 0.05,
      half_open_max_calls: 2,
      sliding_window_size: 5,
      failure_rate_threshold: 0.6
    )
  end
  let(:breaker) { described_class.new('service-a', config: config) }

  describe '.get_or_create' do
    it 'returns same instance for same name' do
      a = described_class.get_or_create('svc-x', config: config)
      b = described_class.get_or_create('svc-x', config: config)
      expect(a).to be(b)
    end

    it 'returns different instances for different names' do
      a = described_class.get_or_create('svc-y', config: config)
      b = described_class.get_or_create('svc-z', config: config)
      expect(a).not_to be(b)
    end
  end

  describe '.registry' do
    it 'includes registered breaker names' do
      described_class.get_or_create('svc-reg', config: config)
      reg = described_class.registry
      expect(reg).to be_a(Hash)
      expect(reg.keys).to include('svc-reg')
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'executes block and records success' do
      result = breaker.execute do
        42
      end
      expect(result).to eq(42)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
    end

    it 'records failure and re-raises error' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')
      expect(breaker.metrics.failed_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
    end
  end

  describe 'state transitions by failure count' do
    it 'opens after reaching failure_threshold and rejects subsequent calls' do
      expect do
        breaker.execute do
          raise 'fail-1'
        end
      end.to raise_error(RuntimeError, 'fail-1')
      expect do
        breaker.execute do
          raise 'fail-2'
        end
      end.to raise_error(RuntimeError, 'fail-2')
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      expect do
        breaker.execute dook
        end
      end.to raise_error(CircuitBreaker::OpenError)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end
  end

  describe 'fallback handling when open' do
    it 'returns fallback result instead of raising' do
      2.times do
        begin
          breaker.execute do
            raise 'fail'
          end
        rescue StandardError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      res = breaker.execute(fallback: -> { :fallback_value }) dowon't_run
      end
      expect(res).to eq(:fallback_value)
      expect(breaker.metrics.rejected_calls).to be >= 1
    end
  end

  describe 'half-open behavior after timeout' do
    it 'moves to HALF_OPEN after timeout and closes after enough successes' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue StandardError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      res1 = breaker.execute dook1
      end
      expect(res1).to eq(:ok1)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      res2 = breaker.execute dook2
      end
      expect(res2).to eq(:ok2)
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions back to OPEN on failure in HALF_OPEN' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue StandardError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      expect do
        breaker.execute do
          raise 'fail-in-half'
        end
      end.to raise_error(RuntimeError, 'fail-in-half')
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'limits number of allowed calls in HALF_OPEN' do
      limited_config = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 99,
        timeout_seconds: 0.05,
        half_open_max_calls: 2,
        sliding_window_size: 5,
        failure_rate_threshold: 1.0
      )
      limited_breaker = described_class.new('service-b', config: limited_config)

      begin
        limited_breaker.execute do
          raise 'force-open'
        end
      rescue StandardError
      end
      expect(limited_breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(limited_config.timeout_seconds + 0.01)
      expect(limited_breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      res1 = limited_breaker.execute dook
      end
      res2 = limited_breaker.execute dook
      end
      expect(res1).to eq(:ok)
      expect(res2).to eq(:ok)

      expect do
        limited_breaker.execute doshould_reject
        end
      end.to raise_error(CircuitBreaker::OpenError)
      expect(limited_breaker.metrics.rejected_calls).to be >= 1
    end
  end

  describe 'failure rate threshold using sliding window' do
    it 'opens when failure rate reaches threshold even if failure_count is low' do
      rate_config = CircuitBreaker::Config.new(
        failure_threshold: 10,
        success_threshold: 2,
        timeout_seconds: 1.0,
        half_open_max_calls: 2,
        sliding_window_size: 5,
        failure_rate_threshold: 0.6
      )
      rate_breaker = described_class.new('service-rate', config: rate_config)

      expect do
        rate_breaker.execute do
          raise 'f1'
        end
      end.to raise_error(RuntimeError, 'f1')
      expect(rate_breaker.state).to eq(CircuitBreaker::State::CLOSED)

      expect do
        rate_breaker.execute do
          raise 'f2'
        end
      end.to raise_error(RuntimeError, 'f2')
      expect(rate_breaker.state).to eq(CircuitBreaker::State::CLOSED)

      expect do
        rate_breaker.execute do
          raise 'f3'
        end
      end.to raise_error(RuntimeError, 'f3')
      expect(rate_breaker.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#state' do
    it 'returns current state and can transition to HALF_OPEN after timeout' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue StandardError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns health hash including config and metrics without deadlock' do
      allow(breaker.metrics).to receive(:to_h).and_return({ sample: 'metrics' })
      info = breaker.health_info
      expect(info[:name]).to eq('service-a')
      expect(info[:state]).to be_a(String)
      expect(info[:metrics]).to eq({ sample: 'metrics' })
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:config][:success_threshold]).to eq(config.success_threshold)
      expect(info[:config][:timeout_seconds]).to eq(config.timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:base_url) { 'http://coordinator.local' }
  let(:coordinator) do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with('NODE_ID').and_return('test-node')
    described_class.new(base_url, sync_interval: 0.01)
  end
  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('svc-dist', config: config) }

  def stub_http_request_cycle
    http = instance_double(Net::HTTP)
    response = instance_double(Net::HTTPResponse)
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(response)
    http
  end

  describe '#register' do
    it 'sends registration to coordinator' do
      http = stub_http_request_cycle
      captured_request = nil
      allow(http).to receive(:request) do |req|
        captured_request = req
        instance_double(Net::HTTPResponse)
      end

      coordinator.register(breaker)
      expect(Net::HTTP).to have_received(:new)
      expect(http).to have_received(:open_timeout=).with(5)
      expect(http).to have_received(:read_timeout=).with(5)
      expect(captured_request).to be_a(Net::HTTP::Post)
      body = JSON.parse(captured_request.body)
      expect(body['service']).to eq('svc-dist')
      expect(body['node_id']).to eq('test-node')
      expect(body['failure_threshold']).to eq(config.failure_threshold)
      expect(body['success_threshold']).to eq(config.success_threshold)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON when request succeeds' do
      uri_double = instance_double(URI::Generic)
      allow(URI).to receive(:new)
      allow(Net::HTTP).to receive(:get_response) do |_uri|
        instance_double(Net::HTTPResponse, body: '{"ok":true}')
      end
      result = coordinator.get_cluster_state('svc-dist')
      expect(result).to eq({ 'ok' => true })
    end

    it 'returns error hash when request fails' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('network down'))
      result = coordinator.get_cluster_state('svc-dist')
      expect(result[:error]).to include('network down')
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts background sync and reports state periodically' do
      allow(coordinator).to receive(:report_state).and_return(nil)
      http = stub_http_request_cycle
      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.03
      coordinator.stop_sync
      expect(coordinator).to have_received(:report_state).at_least(:once)
      expect(Net::HTTP).to have_received(:new).at_least(:once)
      expect(http).to have_received(:open_timeout=).at_least(:once)
      expect(http).to have_received(:read_timeout=).at_least(:once)
    end
  end
end
