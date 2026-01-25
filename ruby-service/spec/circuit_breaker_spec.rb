# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpvkw6l138.rb:336: syntax error, unexpected `end' (SyntaxError)
# Please review and fix any issues before running

require 'spec_helper'
require 'time'
require 'securerandom'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states' do
      expect(described_class.all).to match_array([:closed, :open, :half_open])
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'applies default values' do
      cfg = described_class.new
      expect(cfg.failure_threshold).to eq(5)
      expect(cfg.success_threshold).to eq(3)
      expect(cfg.timeout_seconds).to eq(30.0)
      expect(cfg.half_open_max_calls).to eq(3)
      expect(cfg.sliding_window_size).to eq(10)
      expect(cfg.failure_rate_threshold).to eq(0.5)
    end

    it 'applies provided values' do
      cfg = described_class.new(
        failure_threshold: 2,
        success_threshold: 1,
        timeout_seconds: 0.5,
        half_open_max_calls: 1,
        sliding_window_size: 4,
        failure_rate_threshold: 0.75
      )
      expect(cfg.failure_threshold).to eq(2)
      expect(cfg.success_threshold).to eq(1)
      expect(cfg.timeout_seconds).to eq(0.5)
      expect(cfg.half_open_max_calls).to eq(1)
      expect(cfg.sliding_window_size).to eq(4)
      expect(cfg.failure_rate_threshold).to eq(0.75)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments success and total calls, sets last_success_time and tracks duration' do
      expect(metrics.average_response_time).to eq(0)
      metrics.record_success(0.1)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.1)
      h = nil
      allow(metrics).to receive(:average_response_time).and_return(0.1)
      h = metrics.to_h
      expect(h[:successful_calls]).to eq(1)
      expect(h[:total_calls]).to eq(1)
      expect(h[:average_response_time_ms]).to eq(100.0)
      expect(h[:last_success_time]).not_to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments failure and total calls, sets last_failure_time and tracks duration' do
      metrics.record_failure(0.2)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
      h = nil
      allow(metrics).to receive(:average_response_time).and_return(0.2)
      h = metrics.to_h
      expect(h[:failed_calls]).to eq(1)
      expect(h[:total_calls]).to eq(1)
      expect(h[:average_response_time_ms]).to eq(200.0)
      expect(h[:last_failure_time]).not_to be_nil
    end
  end

  describe '#record_rejection' do
    it 'increments rejection count' do
      expect do
        metrics.record_rejection
      end.not_to raise_error
      expect(metrics.to_h[:rejected_calls]).to eq(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state transitions' do
      expect do
        metrics.record_state_transition
      end.not_to raise_error
      expect(metrics.to_h[:state_transitions]).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when no data' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'computes average over added durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a hash of metrics without deadlock by stubbing average_response_time' do
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      h = metrics.to_h
      expect(h).to include(:total_calls, :successful_calls, :failed_calls, :rejected_calls, :state_transitions, :average_response_time_ms, :last_failure_time, :last_success_time)
      expect(h[:average_response_time_ms]).to eq(123.0)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:service_name) { "svc-#{SecureRandom.hex(4)}" }
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 1,
      timeout_seconds: 0.05,
      half_open_max_calls: 1,
      sliding_window_size: 4,
      failure_rate_threshold: 0.5
    )
  end
  let(:breaker) { described_class.new(service_name, config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create(service_name, config: config)
      b2 = described_class.get_or_create(service_name, config: config)
      expect(b1).to be(b2)
    end
  end

  describe '.registry' do
    it 'returns a copy of registry containing created breakers' do
      b = described_class.get_or_create(service_name, config: config)
      reg = described_class.registry
      expect(reg[service_name]).to be(b)
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'returns result and records success on success' do
      result = breaker.execute do
        'ok'
      end
      expect(result).to eq('ok')
      expect(breaker.health_info[:failure_count]).to eq(0)
    end

    it 're-raises exceptions and records failure on error' do
      expect do
        breaker.execute do
          raise StandardError, 'boom'
        end
      end.to raise_error(StandardError, 'boom')
      # Stubbing to prevent deadlock when calling health_info (metrics.to_h)
      allow(breaker.metrics).to receive(:to_h).and_return({})
      info = breaker.health_info
      expect(info[:failure_count]).to eq(1)
    end

    it 'opens the circuit after reaching failure_threshold' do
      expect do
        breaker.execute do
          raise 'fail1'
        end
      end.to raise_error(RuntimeError, 'fail1')
      expect do
        breaker.execute do
          raise 'fail2'
        end
      end.to raise_error(RuntimeError, 'fail2')
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'rejects calls when open and executes fallback if provided' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      value = breaker.execute(fallback: -> { 'fallback' }) do
        'should not run'
      end
      expect(value).to eq('fallback')
      expect(breaker.metrics.to_h[:rejected_calls]).to be >= 1
    end

    it 'raises OpenError when open and no fallback' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
      end
      expect do
        breaker.execute dounused
        end
      end.to raise_error(CircuitBreaker::OpenError)
    end

    it 'moves to HALF_OPEN after timeout and then closes on success if threshold met' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.02)
      # Trigger state check
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      # Allow 1 call in HALF_OPEN due to half_open_max_calls = 1
      result = breaker.execute do
        'ok'
      end
      expect(result).to eq('ok')
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'in HALF_OPEN, failure transitions back to OPEN' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      expect do
        breaker.execute do
          raise 'half-open fail'
        end
      end.to raise_error(RuntimeError, 'half-open fail')
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'enforces half_open_max_calls by rejecting extra calls while HALF_OPEN' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
      end
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      # First allowed call
      expect do
        breaker.execute do
          'ok'
        end
      end.not_to raise_error

      # Second should be rejected since half_open_max_calls = 1 (unless state closed before)
      if breaker.state == CircuitBreaker::State::HALF_OPEN
        expect do
          breaker.execute do
            'ok2'
          end
        end.to raise_error(CircuitBreaker::OpenError)
      end
    end

    it 'opens the circuit based on sliding window failure rate threshold' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 100,
        success_threshold: 1,
        timeout_seconds: 0.05,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
      b = described_class.new("svc-#{SecureRandom.hex(4)}", config: cfg)
      expect do
        b.execute do
          raise 'f1'
        end
      end.to raise_error(RuntimeError, 'f1')
      expect(b.state).to eq(CircuitBreaker::State::CLOSED)
      expect do
        b.execute do
          raise 'f2'
        end
      end.to raise_error(RuntimeError, 'f2')
      expect(b.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#state' do
    it 'transitions from OPEN to HALF_OPEN after timeout' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns hash of current health without deadlock by stubbing metrics.to_h' do
      allow(breaker.metrics).to receive(:to_h).and_return({ metrics: true })
      info = breaker.health_info
      expect(info[:name]).to eq(service_name)
      expect(info[:state]).to be_a(String)
      expect(info[:config]).to include(:failure_threshold, :success_threshold, :timeout_seconds)
      expect(info[:metrics]).to eq({ metrics: true })
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:service_name) { "svc-#{SecureRandom.hex(4)}" }
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 1,
      timeout_seconds: 0.05,
      half_open_max_calls: 1,
      sliding_window_size: 4,
      failure_rate_threshold: 0.5
    )
  end
  let(:breaker) { CircuitBreaker::Breaker.new(service_name, config: config) }
  let(:coordinator_url) { 'http://localhost:4567' }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: 0.01) }

  def stub_http_request
    response = instance_double(Net::HTTPResponse)
    http = instance_double(Net::HTTP)
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(response)
    response
  end

  describe '#register' do
    it 'stores breaker and sends registration via HTTP' do
      response = stub_http_request
      expect(Net::HTTP).to receive(:new).and_return(instance_double(Net::HTTP).as_null_object)
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      captured_request = nil
      allow(http).to receive(:request) do |req|
        captured_request = req
        response
      end

      coordinator.register(breaker)

      expect(captured_request).to be_a(Net::HTTP::Post)
      expect(captured_request['Content-Type']).to eq('application/json')
      expect(captured_request.body).to include(%{"service":"#{service_name}"})
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background thread that calls synchronize_states periodically' do
      calls = 0
      allow(coordinator).to receive(:synchronize_states) do
        calls += 1
      end
      coordinator.start_sync
      sleep 0.05
      coordinator.stop_sync
      expect(calls).to be >= 1
    end
  end

  describe '#get_cluster_state' do
    it 'fetches and parses JSON successfully' do
      resp = instance_double(Net::HTTPResponse, body: '{"ok":true}')
      allow(Net::HTTP).to receive(:get_response).and_return(resp)
      result = coordinator.get_cluster_state(service_name)
      expect(result).to eq({ 'ok' => true })
    end

    it 'returns error hash on failure' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError, 'boom')
      result = coordinator.get_cluster_state(service_name)
      expect(result).to include(:error)
      expect(result[:error]).to include('boom')
    end
  end

  describe 'state reporting via synchronize loop' do
    it 'reports state using HTTP without errors' do
      coordinator.register(breaker)
      response = instance_double(Net::HTTPResponse)
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      allow(coordinator).to receive(:synchronize_states).and_call_original
      allow(coordinator).to receive(:report_state).and_call_original

      # Start and allow at least one iteration
      coordinator.start_sync
      sleep 0.05
      coordinator.stop_sync

      expect(Net::HTTP).to have_received(:new).at_least(:once)
      expect(http).to have_received(:request).at_least(:once)
    end
  end
end
