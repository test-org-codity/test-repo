require 'spec_helper'
require 'time'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states' do
      expect(described_class.all).to contain_exactly(:closed, :open, :half_open)
    end
  end
end

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    let(:name) do
      'svc'
    end

    let(:remaining) do
      1.23
    end

    it 'sets name and remaining_time and formats message' do
      err = described_class.new(name, remaining)
      expect(err.name).to eq(name)
      expect(err.remaining_time).to eq(remaining)
      expect(err.message).to include("Circuit breaker 'svc' is open")
      expect(err.message).to include('1.23')
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'has sensible defaults' do
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
        success_threshold: 4,
        timeout_seconds: 1.5,
        half_open_max_calls: 7,
        sliding_window_size: 8,
        failure_rate_threshold: 0.75
      )
      expect(cfg.failure_threshold).to eq(2)
      expect(cfg.success_threshold).to eq(4)
      expect(cfg.timeout_seconds).to eq(1.5)
      expect(cfg.half_open_max_calls).to eq(7)
      expect(cfg.sliding_window_size).to eq(8)
      expect(cfg.failure_rate_threshold).to eq(0.75)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) do
    described_class.new
  end

  describe '#record_success' do
    it 'increments successful and total calls and sets last_success_time' do
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.total_calls).to eq(0)
      expect(metrics.last_success_time).to be_nil
      metrics.record_success(0.01)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).to be_a(Time)
    end
  end

  describe '#record_failure' do
    it 'increments failed and total calls and sets last_failure_time' do
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.total_calls).to eq(0)
      expect(metrics.last_failure_time).to be_nil
      metrics.record_failure(0.02)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).to be_a(Time)
    end
  end

  describe '#record_rejection' do
    it 'increments rejected calls' do
      expect(metrics.rejected_calls).to eq(0)
      metrics.record_rejection
      expect(metrics.rejected_calls).to eq(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state transition count' do
      expect(metrics.state_transitions).to eq(0)
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when there are no samples' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns the mean of recorded durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      avg = metrics.average_response_time
      expect(avg).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a summary hash without deadlocking and with ms conversion' do
      metrics.record_success(0.01)
      metrics.record_failure(0.02)
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      h = metrics.to_h
      expect(h[:total_calls]).to eq(2)
      expect(h[:successful_calls]).to eq(1)
      expect(h[:failed_calls]).to eq(1)
      expect(h[:rejected_calls]).to eq(0)
      expect(h[:state_transitions]).to eq(0)
      expect(h[:average_response_time_ms]).to eq(123.0)
      expect(h[:last_success_time]).to be_a(String)
      expect(h[:last_failure_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:name) do
    "svc-#{rand(100_000)}"
  end

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

  let(:breaker) do
    described_class.new(name, config: config)
  end

  describe '.get_or_create' do
    it 'returns same instance for same name' do
      b1 = described_class.get_or_create(name, config: config)
      b2 = described_class.get_or_create(name, config: config)
      expect(b1).to equal(b2)
    end

    it 'does not replace existing instance when config differs' do
      b1 = described_class.get_or_create(name, config: config)
      other_cfg = CircuitBreaker::Config.new(failure_threshold: 10)
      b2 = described_class.get_or_create(name, config: other_cfg)
      expect(b2.config.failure_threshold).to eq(b1.config.failure_threshold)
    end
  end

  describe '.registry' do
    it 'returns a copy, not the original registry' do
      b = described_class.get_or_create(name, config: config)
      reg = described_class.registry
      reg['new'] = :bad
      expect(described_class.registry).not_to have_key('new')
      expect(described_class.registry[name]).to eq(b)
    end
  end

  describe '#execute' do
    it 'requires a block' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'executes the block on success and records metrics' do
      result = breaker.execute do
        'ok'
      end
      expect(result).to eq('ok')
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.metrics.failed_calls).to eq(0)
    end

    it 'records failure and raises the error' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')
      expect(breaker.metrics.failed_calls).to eq(1)
      expect(breaker.state).to eq(:closed)
    end

    it 'opens after reaching failure_threshold' do
      expect do
        breaker.execute do
          raise 'boom1'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom2'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(:open)
    end

    it 'rejects when open and returns fallback result' do
      cfg = CircuitBreaker::Config.new(failure_threshold: 1, timeout_seconds: 0.5)
      br = described_class.new("#{name}-fb", config: cfg)
      expect do
        br.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      result = br.execute(fallback: -> { 'fallback' }) do
        'should not run'
      end
      expect(result).to eq('fallback')
      expect(br.metrics.rejected_calls).to eq(1)
    end

    it 'raises OpenError when open without fallback' do
      cfg = CircuitBreaker::Config.new(failure_threshold: 1, timeout_seconds: 0.5)
      br = described_class.new("#{name}-open", config: cfg)
      expect do
        br.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        br.execute do
          'nope'
        end
      end.to raise_error(CircuitBreaker::OpenError)
    end
  end

  describe '#state' do
    it 'is closed initially' do
      expect(breaker.state).to eq(:closed)
    end

    it 'transitions to open and then to half_open after timeout' do
      expect do
        breaker.execute do
          raise 'boom1'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom2'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(:open)
      sleep config.timeout_seconds + 0.01
      expect(breaker.state).to eq(:half_open)
    end

    it 'limits calls in half-open based on half_open_max_calls' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 2,
        timeout_seconds: 0.05,
        half_open_max_calls: 1
      )
      br = described_class.new("#{name}-half", config: cfg)
      expect do
        br.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      sleep cfg.timeout_seconds + 0.01
      res1 = br.execute do
        'ok-first'
      end
      expect(res1).to eq('ok-first')
      res2 = br.execute(fallback: -> { 'rejected' }) do
        'should-not'
      end
      expect(res2).to eq('rejected')
      expect(br.metrics.rejected_calls).to be >= 1
      expect(br.state).to eq(:half_open)
    end

    it 'closes after enough successes in half-open' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 2,
        timeout_seconds: 0.05,
        half_open_max_calls: 3
      )
      br = described_class.new("#{name}-recover", config: cfg)
      expect do
        br.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      sleep cfg.timeout_seconds + 0.01
      br.execute do
        'ok1'
      end
      expect(br.state).to eq(:half_open)
      br.execute do
        'ok2'
      end
      expect(br.state).to eq(:closed)
    end

    it 're-opens on failure in half-open' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 2,
        timeout_seconds: 0.05,
        half_open_max_calls: 2
      )
      br = described_class.new("#{name}-flip", config: cfg)
      expect do
        br.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      sleep cfg.timeout_seconds + 0.01
      expect do
        br.execute do
          raise 'fail-in-half-open'
        end
      end.to raise_error(RuntimeError)
      expect(br.state).to eq(:open)
    end

    it 'opens based on failure_rate_threshold using sliding window' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 100,
        failure_rate_threshold: 0.5,
        sliding_window_size: 4
      )
      br = described_class.new("#{name}-rate", config: cfg)
      expect do
        br.execute do
          raise 'f1'
        end
      end.to raise_error(RuntimeError)
      expect do
        br.execute do
          raise 'f2'
        end
      end.to raise_error(RuntimeError)
      expect(br.state).to eq(:open)
    end
  end

  describe '#health_info' do
    it 'returns a hash with expected keys and values without deadlock' do
      breaker.execute do
        'ok'
      end
      allow(breaker.metrics).to receive(:average_response_time).and_return(0.0)
      info = breaker.health_info
      expect(info[:name]).to eq(name)
      expect(info[:state]).to be_a(String)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:failure_count]).to be_a(Integer)
      expect(info[:success_count]).to be_a(Integer)
      expect(info[:failure_rate]).to be_a(Float)
      expect(info[:metrics]).to be_a(Hash)
      expect(info[:config]).to include(:failure_threshold, :success_threshold, :timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) do
    'http://example.com'
  end

  let(:coordinator) do
    described_class.new(coordinator_url, sync_interval: 0.01)
  end

  let(:config) do
    CircuitBreaker::Config.new
  end

  let(:breaker) do
    CircuitBreaker::Breaker.new("svc-#{rand(100_000)}", config: config)
  end

  describe '#register' do
    it 'stores breaker and sends registration (network mocked)' do
      expect(coordinator).to receive(:send_registration).with(breaker)
      coordinator.register(breaker)
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a sync loop and stops it' do
      count = 0
      allow(coordinator).to receive(:synchronize_states) do
        count += 1
      end
      coordinator.start_sync
      sleep 0.05
      coordinator.stop_sync
      thr = coordinator.instance_variable_get(:@sync_thread)
      expect(count).to be >= 1
      expect(thr).not_to be_alive
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON on success' do
      body = { 'status' => 'ok', 'nodes' => 3 }.to_json
      resp = instance_double(Net::HTTPResponse, body: body)
      allow(Net::HTTP).to receive(:get_response) do |uri|
        expect(uri.to_s).to include('/circuit-breakers/')
        resp
      end
      result = coordinator.get_cluster_state('svc-a')
      expect(result).to eq(JSON.parse(body))
    end

    it 'returns error hash on failure' do
      allow(Net::HTTP).to receive(:get_response) do
        raise StandardError, 'network down'
      end
      result = coordinator.get_cluster_state('svc-b')
      expect(result).to include(:error)
      expect(result[:error]).to include('network down')
    end
  end

  describe 'sync reporting integration (mocked HTTP)' do
    it 'calls report_state for registered breakers during synchronize_states' do
      coordinator.register(breaker)
      expect(coordinator).to receive(:report_state).with(breaker.name, breaker)
      coordinator.send(:synchronize_states)
    end

    it 'sends HTTP requests in send_registration and report_state without raising (mocked)' do
      http_double = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(instance_double(Net::HTTPResponse))

      expect do
        coordinator.send(:send_registration, breaker)
      end.not_to raise_error

      allow(breaker).to receive(:state).and_return(:closed)
      allow(breaker).to receive(:health_info).and_return({ ok: true })

      expect do
        coordinator.send(:report_state, breaker.name, breaker)
      end.not.to raise_error
    end
  end
end
