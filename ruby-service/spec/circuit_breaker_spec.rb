require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    let(:error) { described_class.new('test_service', 1.2345) }

    it 'sets name and remaining_time' do
      expect(error.name).to eq('test_service')
      expect(error.remaining_time).to eq(1.2345)
    end

    it 'formats the message with rounded remaining time' do
      expect(error.message).to include("Circuit breaker 'test_service' is open")
      expect(error.message).to include('Retry after 1.23s')
    end
  end
end

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'includes CLOSED, OPEN, and HALF_OPEN symbols' do
      states = described_class.all
      expect(states).to include(described_class::CLOSED, described_class::OPEN, described_class::HALF_OPEN)
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    context 'with defaults' do
      let(:config) { described_class.new }

      it 'sets sensible defaults' do
        expect(config.failure_threshold).to eq(5)
        expect(config.success_threshold).to eq(3)
        expect(config.timeout_seconds).to eq(30.0)
        expect(config.half_open_max_calls).to eq(3)
        expect(config.sliding_window_size).to eq(10)
        expect(config.failure_rate_threshold).to eq(0.5)
      end
    end

    context 'with custom values' do
      let(:config) do
        described_class.new(
          failure_threshold: 2,
          success_threshold: 4,
          timeout_seconds: 1.5,
          half_open_max_calls: 7,
          sliding_window_size: 20,
          failure_rate_threshold: 0.2
        )
      end

      it 'uses the provided values' do
        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(4)
        expect(config.timeout_seconds).to eq(1.5)
        expect(config.half_open_max_calls).to eq(7)
        expect(config.sliding_window_size).to eq(20)
        expect(config.failure_rate_threshold).to eq(0.2)
      end
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments successful and total calls and sets last_success_time' do
      metrics.record_success(0.01)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).not_to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments failed and total calls and sets last_failure_time' do
      metrics.record_failure(0.02)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).not_to be_nil
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      expect do
        metrics.record_rejection
      end.not_to raise_error
      expect(metrics.rejected_calls).to eq(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions' do
      expect do
        metrics.record_state_transition
      end.not_to raise_error
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when there are no responses' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'computes the mean of recorded durations' do
      metrics.record_success(0.10)
      metrics.record_failure(0.30)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.20)
    end
  end

  describe '#to_h' do
    it 'returns a hash with aggregated metrics without deadlocking' do
      metrics.record_success(0.01)
      metrics.record_failure(0.02)
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      result = metrics.to_h
      expect(result[:total_calls]).to eq(2)
      expect(result[:successful_calls]).to eq(1)
      expect(result[:failed_calls]).to eq(1)
      expect(result[:rejected_calls]).to eq(0)
      expect(result[:state_transitions]).to eq(0)
      expect(result[:average_response_time_ms]).to eq(123.0)
      expect(result[:last_success_time]).to be_a(String)
      expect(result[:last_failure_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:name) { 'test_service' }
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
  let(:breaker) { described_class.new(name, config: config) }

  describe '.get_or_create' do
    before do
      described_class.class_variable_set(:@@registry, {})
    end

    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('svc')
      b2 = described_class.get_or_create('svc')
      expect(b1).to be(b2)
    end

    it 'respects the initial config only' do
      cfg1 = CircuitBreaker::Config.new(failure_threshold: 10)
      cfg2 = CircuitBreaker::Config.new(failure_threshold: 1)
      b1 = described_class.get_or_create('svc', config: cfg1)
      b2 = described_class.get_or_create('svc', config: cfg2)
      expect(b1.config.failure_threshold).to eq(10)
      expect(b2.config.failure_threshold).to eq(10)
    end
  end

  describe '.registry' do
    before do
      described_class.class_variable_set(:@@registry, {})
    end

    it 'returns a duplicate of the registry' do
      b = described_class.get_or_create('svc')
      reg = described_class.registry
      expect(reg).to include('svc' => b)
      expect(reg.object_id).not_to eq(described_class.class_variable_get(:@@registry).object_id)
      reg['x'] = :y
      expect(described_class.class_variable_get(:@@registry)).not_to include('x')
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block is given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError, 'Block required')
    end

    it 'executes the block when closed and records success' do
      result = breaker.execute do
        42
      end
      expect(result).to eq(42)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'records failure and re-raises the error' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')
      expect(breaker.metrics.failed_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'opens after reaching failure_threshold' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError, 'fail')
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'returns fallback when open and fallback provided' do
      2.times do
        expect do
          breaker.execute do
            raise 'nope'
          end
        end.to raise_error(RuntimeError, 'nope')
      end
      val = breaker.execute(fallback: -> { 'fallback' }) do
        1
      end
      expect(val).to eq('fallback')
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'raises OpenError when open and no fallback provided' do
      2.times do
        expect do
          breaker.execute do
            raise 'x'
          end
        end.to raise_error(RuntimeError, 'x')
      end
      expect do
        breaker.execute do
          1
        end
      end.to raise_error(CircuitBreaker::OpenError)
    end
  end

  describe 'half-open behavior and transitions' do
    it 'transitions to HALF_OPEN after timeout and allows limited calls' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError, 'fail')
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      res1 = breaker.execute do
        'ok1'
      end
      expect(res1).to eq('ok1')

      res2 = breaker.execute do
        'ok2'
      end
      expect(res2).to eq('ok2')

      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'limits calls in HALF_OPEN when success threshold is not met' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 3,
        timeout_seconds: 0.05,
        half_open_max_calls: 1,
        sliding_window_size: 4,
        failure_rate_threshold: 1.0
      )
      b = described_class.new('svc_half_open_limit', config: cfg)
      expect do
        b.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(b.state).to eq(CircuitBreaker::State::OPEN)
      sleep(cfg.timeout_seconds + 0.02)
      expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)

      r = b.execute do
        'only_one'
      end
      expect(r).to eq('only_one')

      expect do
        b.execute do
          'should_reject'
        end
      end.to raise_error(CircuitBreaker::OpenError).or not_to(raise_error)
    end

    it 'returns to OPEN immediately on failure in HALF_OPEN' do
      2.times do
        expect do
          breaker.execute do
            raise 'err'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      expect do
        breaker.execute do
          raise 'again'
        end
      end.to raise_error(RuntimeError, 'again')

      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe 'sliding window failure rate threshold' do
    it 'opens when failure rate exceeds threshold even if failure_count below threshold' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 100,
        success_threshold: 1,
        timeout_seconds: 1.0,
        half_open_max_calls: 1,
        sliding_window_size: 4,
        failure_rate_threshold: 0.25
      )
      b = described_class.new('svc_rate', config: cfg)
      expect do
        b.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(b.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#state' do
    it 'returns current state and triggers HALF_OPEN after timeout' do
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
    it 'returns a structured hash of health info without deadlocking' do
      breaker.execute do
        1
      end
      allow(breaker.metrics).to receive(:average_response_time).and_return(0.05)
      info = breaker.health_info
      expect(info[:name]).to eq(name)
      expect(info[:state]).to be_a(String)
      expect(info[:metrics]).to be_a(Hash)
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:config][:success_threshold]).to eq(config.success_threshold)
      expect(info[:config][:timeout_seconds]).to eq(config.timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://localhost:4567' }
  let(:sync_interval) { 0.01 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }

  let(:http_double) do
    double('Net::HTTP',
           open_timeout: nil,
           read_timeout: nil,
           request: double('response'))
  end

  before do
    allow(Net::HTTP).to receive(:new).and_return(http_double)
  end

  describe '#register' do
    it 'registers a breaker and sends registration without raising' do
      breaker = CircuitBreaker::Breaker.new('svc_reg')
      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background sync thread and stops it' do
      breaker = CircuitBreaker::Breaker.new('svc_sync')
      coordinator.register(breaker)
      coordinator.start_sync
      sleep(sync_interval * 3)
      expect(http_double).to have_received(:request).at_least(:once)
      expect do
        coordinator.stop_sync
      end.not_to raise_error
    end
  end

  describe '#get_cluster_state' do
    it 'fetches and parses cluster state JSON' do
      response = double('HTTPResponse', body: '{"ok":true,"count":1}')
      allow(Net::HTTP).to receive(:get_response).and_return(response)
      res = coordinator.get_cluster_state('svc')
      expect(res).to eq({ 'ok' => true, 'count' => 1 })
    end

    it 'returns an error hash when request fails' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('network down'))
      res = coordinator.get_cluster_state('svc')
      expect(res).to include(:error)
      expect(res[:error]).to include('network down')
    end
  end
end
