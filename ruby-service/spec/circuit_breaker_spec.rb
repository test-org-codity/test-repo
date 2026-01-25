require 'spec_helper'
require 'time'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    let(:error) { described_class.new('svc', 12.3456) }

    it 'sets name and remaining_time' do
      expect(error.name).to eq('svc')
      expect(error.remaining_time).to eq(12.3456)
    end

    it 'formats message with rounded remaining time' do
      expect(error.message).to include("Circuit breaker 'svc' is open. Retry after 12.35s")
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
    context 'with defaults' do
      let(:config) { described_class.new }

      it 'sets default thresholds and timeouts' do
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
          half_open_max_calls: 5,
          sliding_window_size: 20,
          failure_rate_threshold: 0.7
        )
      end

      it 'applies provided values' do
        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(4)
        expect(config.timeout_seconds).to eq(1.5)
        expect(config.half_open_max_calls).to eq(5)
        expect(config.sliding_window_size).to eq(20)
        expect(config.failure_rate_threshold).to eq(0.7)
      end
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success and #record_failure' do
    it 'increments counters and updates timestamps and response times' do
      allow(Time).to receive(:now).and_return(Time.now)
      metrics.record_success(0.1)
      expect(metrics.to_h[:successful_calls]).to eq(1)
      expect(metrics.to_h[:total_calls]).to eq(1)
      expect(metrics.to_h[:last_success_time]).to be_a(String)

      metrics.record_failure(0.3)
      data = metrics.to_h
      expect(data[:failed_calls]).to eq(1)
      expect(data[:total_calls]).to eq(2)
      expect(data[:last_failure_time]).to be_a(String)
      expect(data[:average_response_time_ms]).to be > 0
    end
    it 'computes average response time in seconds' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
      expect(metrics.to_h[:average_response_time_ms]).to be_within(0.01).of(200.0)
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      metrics.record_rejection
      metrics.record_rejection
      expect(metrics.to_h[:rejected_calls]).to eq(2)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions' do
      metrics.record_state_transition
      metrics.record_state_transition
      expect(metrics.to_h[:state_transitions]).to eq(2)
    end
  end

  describe '#to_h' do
    it 'returns a hash with expected keys' do
      metrics.record_success(0.05)
      h = metrics.to_h
      expect(h).to include(:total_calls, :successful_calls, :failed_calls, :rejected_calls, :state_transitions,
                           :average_response_time_ms, :last_failure_time, :last_success_time)
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
      failure_rate_threshold: 0.5
    )
  end
  let(:breaker_name) { "service-#{SecureRandom.hex(4)}" }
  let(:breaker) { described_class.new(breaker_name, config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      a = described_class.get_or_create('shared', config: config)
      b = described_class.get_or_create('shared', config: config)
      expect(a).to equal(b)
    end

    it 'returns different instances for different names' do
      a = described_class.get_or_create("a-#{SecureRandom.hex(3)}", config: config)
      b = described_class.get_or_create("b-#{SecureRandom.hex(3)}", config: config)
      expect(a).not_to equal(b)
    end
  end

  describe '.registry' do
    it 'returns a hash of registered breakers' do
      a = described_class.get_or_create("reg-#{SecureRandom.hex(3)}", config: config)
      reg = described_class.registry
      expect(reg).to be_a(Hash)
      expect(reg[a.name]).to eq(a)
    end
  end

  describe '#state' do
    it 'starts closed' do
      expect(breaker.state).to eq(:closed)
    end
  end

  describe '#execute' do
    context 'when no block is provided' do
      it 'raises ArgumentError' do
        expect do
          breaker.execute
        end.to raise_error(ArgumentError)
      end
    end

    context 'when the block succeeds' do
      it 'returns the result and records success' do
        result = breaker.execute do
          'ok'
        end
        expect(result).to eq('ok')
        info = breaker.health_info
        expect(info[:metrics][:successful_calls]).to eq(1)
        expect(info[:state]).to eq('CLOSED')
      end
    end

    context 'when the block raises an error' do
      it 're-raises and records failure' do
        expect do
          breaker.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError, 'boom')
        info = breaker.health_info
        expect(info[:metrics][:failed_calls]).to eq(1)
      end

      it 'opens after reaching failure_threshold' do
        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError)
        end
        expect(breaker.state).to eq(:open)
        expect(breaker.health_info[:metrics][:state_transitions]).to be >= 1
      end
    end

    context 'when circuit is open' do
      before do
        2.times do
          breaker.execute do
            raise 'fail'
          end
        rescue StandardError
        end
        expect(breaker.state).to eq(:open)
      end

      it 'returns fallback when provided and counts rejection' do
        fallback = proc do
          'fallback'
        end
        result = breaker.execute(fallback: fallback) do
          'should not run'
        end
        expect(result).to eq('fallback')
        expect(breaker.health_info[:metrics][:rejected_calls]).to eq(1)
      end

      it 'raises OpenError with remaining time when no fallback' do
        expect do
          breaker.execute do
            'no-op'
          end
        end.to raise_error(CircuitBreaker::OpenError) do |e|
          expect(e.name).to eq(breaker_name)
          expect(e.remaining_time).to be >= 0
          expect(e.remaining_time).to be <= config.timeout_seconds
        end
      end
    end

    context 'half-open behavior' do
      before do
        2.times do
          breaker.execute do
            raise 'fail'
          end
        rescue StandardError
        end
        expect(breaker.state).to eq(:open)
        sleep(config.timeout_seconds + 0.02)
        expect(breaker.state).to eq(:half_open)
      end

      it 'allows up to half_open_max_calls concurrently' do
        # First two calls allowed
        2.times do
          result = breaker.execute do
            'ok'
          end
          expect(result).to eq('ok')
        end
        # Third call should be rejected
        expect do
          breaker.execute do
            'no-op'
          end
        end.to raise_error(CircuitBreaker::OpenError) do |e|
          expect(e.remaining_time).to eq(0)
        end
      end

      it 'closes after reaching success_threshold successes' do
        2.times do
          breaker.execute do
            'ok'
          end
        end
        expect(breaker.state).to eq(:closed)
      end

      it 're-opens immediately on a failure' do
        expect do
          breaker.execute do
            raise 'half-open fail'
          end
        end.to raise_error(RuntimeError, 'half-open fail')
        expect(breaker.state).to eq(:open)
      end
    end

    context 'failure rate threshold in sliding window' do
      let(:rate_config) do
        CircuitBreaker::Config.new(
          failure_threshold: 10,
          success_threshold: 2,
          timeout_seconds: 0.05,
          half_open_max_calls: 2,
          sliding_window_size: 4,
          failure_rate_threshold: 0.5
        )
      end
      let(:rate_breaker) { described_class.new("rate-#{SecureRandom.hex(4)}", config: rate_config) }

      it 'opens when failure rate exceeds threshold even if failure_count is low' do
        # Two successes then three failures -> window of 4 with at least 2 failures => rate >= 0.5
        rate_breaker.execute do
          'ok'
        end
        rate_breaker.execute do
          'ok'
        end
        2.times do
          rate_breaker.execute do
            raise 'fail'
          end
        rescue StandardError
        end
        expect(rate_breaker.state).to eq(:open)
      end
    end
  end

  describe '#health_info' do
    it 'returns a detailed hash with state and config' do
      breaker.execute do
        'ok'
      end
      info = breaker.health_info
      expect(info[:name]).to eq(breaker_name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:metrics][:total_calls]).to eq(1)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.local:8080' }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: 0.02) }
  let(:config) { CircuitBreaker::Config.new(timeout_seconds: 0.01) }
  let(:breaker) { CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(3)}", config: config) }

  describe '#register' do
    it 'sends registration via HTTP' do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(double)

      coordinator.register(breaker)

      expect(Net::HTTP).to have_received(:new)
      expect(http).to have_received(:request).with(instance_of(Net::HTTP::Post))
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'periodically reports state while running' do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(double)

      coordinator.register(breaker)
      coordinator.start_sync
      sleep(0.06)
      coordinator.stop_sync

      expect(http).to have_received(:request).with(instance_of(Net::HTTP::Post)).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON on success' do
      response = double
      allow(response).to receive(:body).and_return('{"ok":true}')
      allow(Net::HTTP).to receive(:get_response).and_return(response)

      res = coordinator.get_cluster_state('svc')
      expect(res).to eq('ok' => true)
    end

    it 'returns error hash on failure' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('network down'))

      res = coordinator.get_cluster_state('svc')
      expect(res).to include(:error)
      expect(res[:error]).to include('network down')
    end
  end
end
