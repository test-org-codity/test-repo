require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::Error do
  it 'inherits from StandardError' do
    expect(described_class.superclass).to eq(StandardError)
  end
end

RSpec.describe CircuitBreaker::OpenError do
  let(:name) { 'service_a' }
  let(:remaining_time) { 12.345 }

  subject(:error) { described_class.new(name, remaining_time) }

  it 'inherits from CircuitBreaker::Error' do
    expect(described_class.superclass).to eq(CircuitBreaker::Error)
  end

  it 'exposes name and remaining_time' do
    expect(error.name).to eq(name)
    expect(error.remaining_time).to eq(remaining_time)
  end

  it 'builds a descriptive message' do
    expect(error.message).to include("Circuit breaker 'service_a' is open")
    expect(error.message).to include(remaining_time.round(2).to_s)
  end
end

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states' do
      expect(described_class.all).to contain_exactly(
        CircuitBreaker::State::CLOSED,
        CircuitBreaker::State::OPEN,
        CircuitBreaker::State::HALF_OPEN
      )
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    context 'with defaults' do
      subject(:config) { described_class.new }

      it 'sets default failure_threshold' do
        expect(config.failure_threshold).to eq(5)
      end

      it 'sets default success_threshold' do
        expect(config.success_threshold).to eq(3)
      end

      it 'sets default timeout_seconds' do
        expect(config.timeout_seconds).to eq(30.0)
      end

      it 'sets default half_open_max_calls' do
        expect(config.half_open_max_calls).to eq(3)
      end

      it 'sets default sliding_window_size' do
        expect(config.sliding_window_size).to eq(10)
      end

      it 'sets default failure_rate_threshold' do
        expect(config.failure_rate_threshold).to eq(0.5)
      end
    end

    context 'with custom values' do
      subject(:config) do
        described_class.new(
          failure_threshold: 10,
          success_threshold: 2,
          timeout_seconds: 5.5,
          half_open_max_calls: 7,
          sliding_window_size: 20,
          failure_rate_threshold: 0.7
        )
      end

      it 'applies custom configuration' do
        expect(config.failure_threshold).to eq(10)
        expect(config.success_threshold).to eq(2)
        expect(config.timeout_seconds).to eq(5.5)
        expect(config.half_open_max_calls).to eq(7)
        expect(config.sliding_window_size).to eq(20)
        expect(config.failure_rate_threshold).to eq(0.7)
      end
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  describe '#initialize' do
    it 'starts all counters at zero and times at nil' do
      metrics = described_class.new
      expect(metrics.total_calls).to eq(0)
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.rejected_calls).to eq(0)
      expect(metrics.state_transitions).to eq(0)
      expect(metrics.last_failure_time).to be_nil
      expect(metrics.last_success_time).to be_nil
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

  subject(:breaker) { described_class.new('test_service', config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('service1')
      b2 = described_class.get_or_create('service1')
      expect(b1).to be(b2)
    end

    it 'returns different instances for different names' do
      b1 = described_class.get_or_create('service1')
      b2 = described_class.get_or_create('service2')
      expect(b1).not_to be(b2)
    end

    it 'uses provided config on first creation' do
      custom_config = CircuitBreaker::Config.new(failure_threshold: 10)
      b1 = described_class.get_or_create('service3', config: custom_config)
      expect(b1.config.failure_threshold).to eq(10)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry hash' do
      b1 = described_class.get_or_create('reg_service')
      registry = described_class.registry
      expect(registry).to be_a(Hash)
      expect(registry['reg_service']).to eq(b1)
      registry['reg_service'] = nil
      expect(described_class.registry['reg_service']).to eq(b1)
    end
  end

  describe '#execute' do
    context 'when no block is given' do
      it 'raises ArgumentError' do
        expect do
          breaker.execute
        end.to raise_error(ArgumentError, 'Block required')
      end
    end

    context 'when circuit is closed' do
      it 'records failures and may open the circuit' do
        2.times do
          expect do
            breaker.execute do
              raise 'failure'
            end
          end.to raise_error(RuntimeError, 'failure')
        end
        expect(breaker.metrics.failed_calls).to eq(2)
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end

    context 'when circuit is open' do
      before do
        2.times do
          breaker.execute do
            raise 'failure'
          end
        rescue RuntimeError
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'raises OpenError when no fallback is provided' do
        expect do
          breaker.execute do
            should_not_run
          end
        end.to raise_error(CircuitBreaker::OpenError)
        expect(breaker.metrics.rejected_calls).to eq(1)
      end
    end

    context 'when circuit transitions to half-open and closed' do
      before do
        2.times do
          breaker.execute do
            raise 'failure'
          end
        rescue RuntimeError
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        sleep(config.timeout_seconds + 0.05)
      end

      it 'reopens on failure in half-open' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute do
            raise 'half-open failure'
          end
        end.to raise_error(RuntimeError, 'half-open failure')

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end
  end

  describe '#state' do
    it 'returns CLOSED initially' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to OPEN after enough failures' do
      2.times do
        breaker.execute do
          raise 'failure'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'moves from OPEN to HALF_OPEN after timeout' do
      2.times do
        breaker.execute do
          raise 'failure'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.05)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.test' }
  subject(:coordinator) { described_class.new(coordinator_url, sync_interval: 0.01) }

  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('service_a', config: config) }

  before do
    allow(Net::HTTP).to receive(:new).and_call_original
  end

  describe '#register' do
    it 'stores the breaker and sends registration without error' do
      http_double = instance_double(Net::HTTP)
      response_double = instance_double(Net::HTTPResponse)

      allow(Net::HTTP).to receive(:new).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(response_double)

      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts and stops the sync thread without error' do
      http_double = instance_double(Net::HTTP)
      response_double = instance_double(Net::HTTPResponse)

      allow(Net::HTTP).to receive(:new).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(response_double)

      coordinator.register(breaker)

      expect do
        coordinator.start_sync
        sleep(0.03)
        coordinator.stop_sync
      end.not_to raise_error
    end
  end

  describe '#get_cluster_state' do
    let(:uri_double) { URI("#{coordinator_url}/circuit-breakers/service_a/aggregate") }

    it 'returns parsed JSON on success' do
      response_double = instance_double(Net::HTTPResponse, body: '{"status":"ok"}')
      expect(Net::HTTP).to receive(:get_response).with(uri_double).and_return(response_double)

      result = coordinator.get_cluster_state('service_a')
      expect(result).to eq('status' => 'ok')
    end

    it 'returns error hash on failure' do
      expect(Net::HTTP).to receive(:get_response).with(uri_double).and_raise(StandardError.new('network error'))

      result = coordinator.get_cluster_state('service_a')
      expect(result[:error]).to eq('network error')
    end
  end
end
