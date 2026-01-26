# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpvaqldru8.rb:207: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
...back_result }) doshould_not_run
...               ^~~~~~~~~~~~~~~~
/tmp/tmpvaqldru8.rb:211: syntax error, unexpected `end'
    end
    ^~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name and remaining_time and formats message' do
      err = described_class.new('db', 5.0)
      expect(err.name).to eq('db')
      expect(err.remaining_time).to eq(5.0)
      expect(err.message).to include("Circuit breaker 'db' is open")
      expect(err.message).to include('Retry after 5.0s')
    end
  end
end

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states' do
      expect(described_class.all).to eq([:closed, :open, :half_open])
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'sets default values' do
      cfg = described_class.new
      expect(cfg.failure_threshold).to eq(5)
      expect(cfg.success_threshold).to eq(3)
      expect(cfg.timeout_seconds).to eq(30.0)
      expect(cfg.half_open_max_calls).to eq(3)
      expect(cfg.sliding_window_size).to eq(10)
      expect(cfg.failure_rate_threshold).to eq(0.5)
    end

    it 'accepts overrides' do
      cfg = described_class.new(
        failure_threshold: 2,
        success_threshold: 1,
        timeout_seconds: 0.1,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.7
      )
      expect(cfg.failure_threshold).to eq(2)
      expect(cfg.success_threshold).to eq(1)
      expect(cfg.timeout_seconds).to eq(0.1)
      expect(cfg.half_open_max_calls).to eq(2)
      expect(cfg.sliding_window_size).to eq(4)
      expect(cfg.failure_rate_threshold).to eq(0.7)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#initialize' do
    it 'starts with zeroed counters and nil times' do
      expect(metrics.total_calls).to eq(0)
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.rejected_calls).to eq(0)
      expect(metrics.state_transitions).to eq(0)
      expect(metrics.last_failure_time).to be_nil
      expect(metrics.last_success_time).to be_nil
      expect(metrics.average_response_time).to eq(0)
    end
  end

  describe '#record_success' do
    it 'increments success and total and updates last_success_time' do
      metrics.record_success(0.01)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).not_to be_nil
      expect(metrics.average_response_time).to be > 0
    end
  end

  describe '#record_failure' do
    it 'increments failure and total and updates last_failure_time' do
      metrics.record_failure(0.02)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).not_to be_nil
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      metrics.record_rejection
      expect(metrics.rejected_calls).to eq(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions' do
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'computes average across recorded durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to eq(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a hash with expected keys and ms average' do
      metrics.record_success(0.01)
      metrics.record_failure(0.02)
      allow(metrics).to receive(:average_response_time).and_return(0.0123)
      h = metrics.to_h
      expect(h[:total_calls]).to eq(2)
      expect(h[:successful_calls]).to eq(1)
      expect(h[:failed_calls]).to eq(1)
      expect(h[:rejected_calls]).to eq(0)
      expect(h[:state_transitions]).to eq(0)
      expect(h[:average_response_time_ms]).to eq(1.23)
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
      sliding_window_size: 4,
      failure_rate_threshold: 0.75
    )
  end
  let(:breaker_name) { "service-#{SecureRandom.hex(4)}" }
  let(:breaker) { described_class.new(breaker_name, config: config) }

  describe '.get_or_create' do
    it 'returns same instance for same name' do
      b1 = described_class.get_or_create('shared-svc', config: config)
      b2 = described_class.get_or_create('shared-svc', config: config)
      expect(b1).to be(b2)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry hash' do
      b = described_class.get_or_create("reg-#{SecureRandom.hex(3)}", config: config)
      reg = described_class.registry
      expect(reg).to be_a(Hash)
      expect(reg[b.name]).to eq(b)
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'executes the block on success and records metrics' do
      result = breaker.execute do
        123
      end
      expect(result).to eq(123)
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.send(:calculate_failure_rate)).to be_between(0.0, 1.0)
      expect(breaker.state).to eq(:closed)
    end

    it 'records failure and opens after reaching failure_threshold' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')

      expect do
        breaker.execute do
          raise 'bang'
        end
      end.to raise_error(RuntimeError, 'bang')

      expect(breaker.state).to eq(:open)
      expect(breaker.metrics.failed_calls).to eq(2)
    end

    it 'uses fallback when open and increments rejected_calls' do
      2.times do
        begin
          breaker.execute do
            raise 'err'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(:open)

      result = breaker.execute(fallback: -> { :fallback_result }) doshould_not_run
      end
      expect(result).to eq(:fallback_result)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'raises OpenError when open without fallback' do
      2.times do
        expect do
          breaker.execute do
            raise 'err'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(:open)
      expect do
        breaker.execute donope
        end
      end.to raise_error(CircuitBreaker::OpenError)
    end

    it 'moves to HALF_OPEN after timeout and limits calls by half_open_max_calls' do
      2.times do
        begin
          breaker.execute do
            raise 'err'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(:open)

      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(:half_open)

      val1 = breaker.execute do
        'ok1'
      end
      val2 = breaker.execute do
        'ok2'
      end
      expect(val1).to eq('ok1')
      expect(val2).to eq('ok2')

      expect do
        breaker.execute do
          'third call should be rejected'
        end
      end.to raise_error(CircuitBreaker::OpenError)
    end

    it 'closes after sufficient successes in HALF_OPEN' do
      2.times do
        begin
          breaker.execute do
            raise 'err'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(:open)

      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(:half_open)

      breaker.execute dosuccess1
      end
      breaker.execute dosuccess2
      end
      expect(breaker.state).to eq(:closed)
    end

    it 'reopens when a failure occurs in HALF_OPEN' do
      2.times do
        begin
          breaker.execute do
            raise 'err'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(:open)

      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(:half_open)

      expect do
        breaker.execute do
          raise 'fail_in_half_open'
        end
      end.to raise_error(RuntimeError, 'fail_in_half_open')

      expect(breaker.state).to eq(:open)
    end

    it 'opens based on sliding window failure rate threshold' do
      rate_cfg = CircuitBreaker::Config.new(
        failure_threshold: 100,
        success_threshold: 1,
        timeout_seconds: 0.05,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
      rb = described_class.new("rate-#{SecureRandom.hex(3)}", config: rate_cfg)

      rb.execute dosuccess
      end
      expect do
        rb.execute do
          raise 'f1'
        end
      end.to raise_error(RuntimeError, 'f1')
      expect do
        rb.execute do
          raise 'f2'
        end
      end.to raise_error(RuntimeError, 'f2')
      expect do
        rb.execute do
          raise 'f3'
        end
      end.to raise_error(RuntimeError, 'f3')

      expect(rb.state).to eq(:open)
    end
  end

  describe '#state' do
    it 'returns current state and triggers HALF_OPEN after timeout' do
      2.times do
        begin
          breaker.execute do
            raise 'err'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(:open)
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(:half_open)
    end
  end

  describe '#health_info' do
    it 'returns a hash with uppercased state and config' do
      metrics_double = instance_double(CircuitBreaker::Metrics)
      allow(metrics_double).to receive(:to_h).and_return({ avg: 0 })
      breaker.instance_variable_set(:@metrics, metrics_double)
      info = breaker.health_info
      expect(info[:name]).to eq(breaker_name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:failure_count]).to be_a(Integer)
      expect(info[:success_count]).to be_a(Integer)
      expect(info[:failure_rate]).to be_between(0.0, 1.0)
      expect(info[:metrics]).to eq({ avg: 0 })
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:config][:success_threshold]).to eq(config.success_threshold)
      expect(info[:config][:timeout_seconds]).to eq(config.timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.local' }
  let(:sync_interval) { 0.02 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }

  def stub_http_with_request_capture
    http = instance_double(Net::HTTP)
    response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    captured = []
    allow(http).to receive(:request) do |req|
      captured << req
      response
    end
    [http, captured]
  end

  describe '#register' do
    it 'sends registration to coordinator' do
      http, captured = stub_http_with_request_capture
      cfg = CircuitBreaker::Config.new
      br = CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(3)}", config: cfg)

      coordinator.register(br)

      expect(Net::HTTP).to have_received(:new)
      expect(http).to have_received(:open_timeout=).with(5)
      expect(http).to have_received(:read_timeout=).with(5)
      expect(captured.size).to eq(1)
      body = JSON.parse(captured.first.body)
      expect(body['service']).to eq(br.name)
      expect(body['node_id']).to be_a(String)
      expect(body['failure_threshold']).to eq(cfg.failure_threshold)
      expect(body['success_threshold']).to eq(cfg.success_threshold)
    end

    it 'rescues network errors during registration' do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(StandardError.new('network down'))

      br = CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(3)}")
      expect do
        coordinator.register(br)
      end.not_to raise_error
    end
  end

  describe '#get_cluster_state' do
    it 'fetches aggregate state and parses JSON' do
      response = instance_double(Net::HTTPResponse, body: '{"state":"OK"}')
      allow(Net::HTTP).to receive(:get_response).and_return(response)
      data = coordinator.get_cluster_state('payments')
      expect(data).to eq({ 'state' => 'OK' })
    end

    it 'returns error hash on failure' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('boom'))
      result = coordinator.get_cluster_state('payments')
      expect(result[:error]).to eq('boom')
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'periodically reports breaker states without raising' do
      http, _captured = stub_http_with_request_capture
      br = CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(3)}")
      coordinator.register(br)

      expect do
        coordinator.start_sync
        sleep(sync_interval * 3)
        coordinator.stop_sync
      end.not_to raise_error

      expect(http).to have_received(:request).at_least(:once)
    end

    it 'rescues errors during report_state' do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(StandardError.new('send failed'))

      br = CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(3)}")
      coordinator.register(br)

      expect do
        coordinator.start_sync
        sleep(sync_interval * 3)
        coordinator.stop_sync
      end.not_to raise_error
    end
  end
end
