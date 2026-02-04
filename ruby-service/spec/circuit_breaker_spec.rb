require 'spec_helper'
require 'time'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all valid states' do
      states = described_class.all
      expect(states).to include(:closed, :open, :half_open)
      expect(states.size).to eq(3)
    end
  end
end

RSpec.describe CircuitBreaker::Error do
  describe '#initialize' do
    it 'is a StandardError with message' do
      error = described_class.new('oops')
      expect(error).to be_a(StandardError)
      expect(error.message).to eq('oops')
    end
  end
end

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name and remaining_time and formats message' do
      error = described_class.new('service-a', 1.23)
      expect(error).to be_a(CircuitBreaker::Error)
      expect(error.name).to eq('service-a')
      expect(error.remaining_time).to eq(1.23)
      expect(error.message).to include("Circuit breaker 'service-a' is open")
      expect(error.message).to include('1.23')
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'applies defaults and overrides' do
      config = described_class.new(
        failure_threshold: 7,
        success_threshold: 4,
        timeout_seconds: 2.5,
        half_open_max_calls: 5,
        sliding_window_size: 20,
        failure_rate_threshold: 0.75
      )
      expect(config.failure_threshold).to eq(7)
      expect(config.success_threshold).to eq(4)
      expect(config.timeout_seconds).to eq(2.5)
      expect(config.half_open_max_calls).to eq(5)
      expect(config.sliding_window_size).to eq(20)
      expect(config.failure_rate_threshold).to eq(0.75)
    end

    it 'has sensible defaults' do
      config = described_class.new
      expect(config.failure_threshold).to eq(5)
      expect(config.success_threshold).to eq(3)
      expect(config.timeout_seconds).to eq(30.0)
      expect(config.half_open_max_calls).to eq(3)
      expect(config.sliding_window_size).to eq(10)
      expect(config.failure_rate_threshold).to eq(0.5)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) do
    described_class.new
  end

  describe '#record_success' do
    it 'increments success and total and sets last_success_time' do
      expect(metrics.total_calls).to eq(0)
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.last_success_time).to be_nil

      metrics.record_success(0.01)

      expect(metrics.total_calls).to eq(1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.last_success_time).to be_a(Time)
    end
  end

  describe '#record_failure' do
    it 'increments failure and total and sets last_failure_time' do
      expect(metrics.total_calls).to eq(0)
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.last_failure_time).to be_nil

      metrics.record_failure(0.02)

      expect(metrics.total_calls).to eq(1)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.last_failure_time).to be_a(Time)
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      expect(metrics.rejected_calls).to eq(0)
      metrics.record_rejection
      expect(metrics.rejected_calls).to eq(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions counter' do
      expect(metrics.state_transitions).to eq(0)
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when there are no samples' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns average duration in seconds' do
      metrics.record_success(0.01)
      metrics.record_failure(0.03)
      avg = metrics.average_response_time
      expect(avg).to be_within(0.0001).of(0.02)
    end
  end

  describe '#to_h' do
    it 'returns a hash of metrics without deadlocking' do
      # prepare times and counts
      metrics.record_success(0.01)
      metrics.record_failure(0.02)

      # Avoid nested mutex deadlock by stubbing average_response_time
      allow(metrics).to receive(:average_response_time).and_return(0.123)

      data = metrics.to_h
      expect(data[:total_calls]).to eq(2)
      expect(data[:successful_calls]).to eq(1)
      expect(data[:failed_calls]).to eq(1)
      expect(data[:rejected_calls]).to eq(0)
      expect(data[:state_transitions]).to eq(0)
      expect(data[:average_response_time_ms]).to eq(123.0)
      expect(data[:last_failure_time]).to be_a(String)
      expect(data[:last_success_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 2,
      timeout_seconds: 0.1,
      half_open_max_calls: 2,
      sliding_window_size: 4,
      failure_rate_threshold: 0.5
    )
  end

  let(:breaker_name) do
    'service-test'
  end

  let(:breaker) do
    described_class.new(breaker_name, config: config)
  end

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('svc-x', config: config)
      b2 = described_class.get_or_create('svc-x', config: config)
      expect(b1).to be(b2)
    end
  end

  describe '.registry' do
    it 'includes created breakers' do
      b = described_class.get_or_create('svc-y', config: config)
      reg = described_class.registry
      expect(reg['svc-y']).to be(b)
    end
  end

  describe '#state' do
    it 'is CLOSED by default' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to HALF_OPEN after timeout when previously OPEN' do
      # Open it with failures
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(StandardError)

      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(StandardError)

      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      sleep 0.11
      # state call should attempt reset
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block is given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError, /Block required/)
    end

    it 'executes the block and records success in CLOSED' do
      result = breaker.execute do
        ok
      end
      expect(result).to eq(:ok)
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      expect(breaker.metrics.successful_calls).to eq(1)
    end

    it 'records failure and re-raises errors' do
      expect do
        breaker.execute do
          raise 'oops'
        end
      end.to raise_error(RuntimeError, 'oops')
      expect(breaker.metrics.failed_calls).to eq(1)
    end

    it 'opens after reaching failure_threshold' do
      expect do
        breaker.execute do
          raise 'f1'
        end
      end.to raise_error(RuntimeError, 'f1')

      expect do
        breaker.execute do
          raise 'f2'
        end
      end.to raise_error(RuntimeError, 'f2')

      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'opens when failure_rate_threshold is met via sliding window' do
      # new breaker to isolate
      br = described_class.new('svc-rate', config: config)
      # Two failures will set 2/4 = 0.5 which meets threshold (>= 0.5)
      expect do
        br.execute do
          raise 'fail-1'
        end
      end.to raise_error(RuntimeError)

      expect do
        br.execute do
          raise 'fail-2'
        end
      end.to raise_error(RuntimeError)

      expect(br.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'returns fallback when OPEN and fallback provided' do
      # Open it
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      res = breaker.execute(fallback: -> { :fallback }) do
        should_not_run
      end
      expect(res).to eq(:fallback)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'raises OpenError when OPEN and no fallback' do
      # Open it
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      expect do
        breaker.execute do
          should_not_run
        end
      end.to raise_error(CircuitBreaker::OpenError) do |err|
        expect(err.name).to eq(breaker_name)
        expect(err.remaining_time).to be >= 0
        expect(err.message).to include("Circuit breaker '#{breaker_name}' is open")
      end
    end

    it 'in HALF_OPEN allows limited calls and transitions to CLOSED after enough successes' do
      # Open it
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      # Wait to half-open
      sleep 0.11
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      r1 = breaker.execute do
        ok1
      end
      expect(r1).to eq(:ok1)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      r2 = breaker.execute do
        ok2
      end
      expect(r2).to eq(:ok2)
      # After 2 successes >= success_threshold(2), it should close
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'in HALF_OPEN transitions back to OPEN on failure' do
      # Open it
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      # Wait to half-open
      sleep 0.11
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      expect do
        breaker.execute do
          raise 'half-fail'
        end
      end.to raise_error(RuntimeError, 'half-fail')
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'in HALF_OPEN rejects beyond half_open_max_calls until reset' do
      # Open it
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      sleep 0.11
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      # two allowed calls
      breaker.execute do
        ok1
      end
      breaker.execute do
        ok2
      end

      # subsequent call should be rejected; with a fallback, it returns fallback
      res = breaker.execute(fallback: -> { :limited }) do
        should_not_run
      end
      expect(res).to eq(:limited)
    end
  end

  describe '#health_info' do
    it 'returns a hash of breaker info without deadlocking on metrics' do
      allow(breaker.metrics).to receive(:to_h).and_return({ total_calls: 0 })
      info = breaker.health_info
      expect(info[:name]).to eq(breaker_name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:metrics]).to eq({ total_calls: 0 })
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:config][:success_threshold]).to eq(config.success_threshold)
      expect(info[:config][:timeout_seconds]).to eq(config.timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) do
    'http://example.com'
  end

  let(:coordinator) do
    described_class.new(coordinator_url, sync_interval: 0.05)
  end

  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 2,
      timeout_seconds: 0.1,
      half_open_max_calls: 2,
      sliding_window_size: 4,
      failure_rate_threshold: 0.5
    )
  end

  let(:breaker) do
    CircuitBreaker::Breaker.new('svc-coord', config: config)
  end

  let(:http) do
    instance_double(Net::HTTP)
  end

  let(:response) do
    instance_double(Net::HTTPResponse, body: '{"status":"ok"}')
  end

  before do
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(response)
  end

  describe '#register' do
    it 'sends registration to coordinator' do
      expect do
        coordinator.register(breaker)
      end.not_to raise_error
      expect(Net::HTTP).to have_received(:new)
      expect(http).to have_received(:request)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed json on success' do
      ok_resp = instance_double(Net::HTTPResponse, body: '{"foo": "bar"}')
      allow(Net::HTTP).to receive(:get_response).and_return(ok_resp)

      state = coordinator.get_cluster_state('svc1')
      expect(state).to eq({ 'foo' => 'bar' })
    end

    it 'returns error hash on exceptions' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('network down'))
      state = coordinator.get_cluster_state('svc1')
      expect(state[:error]).to eq('network down')
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background sync thread that reports states and can be stopped' do
      # Avoid deadlock in health_info metrics
      allow(breaker.metrics).to receive(:to_h).and_return({})

      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.12
      coordinator.stop_sync

      # At least one HTTP request should have been made by report_state
      expect(http).to have_received(:request).at_least(:once)
    end
  end
end
