require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  let(:name) { 'service_a' }
  let(:remaining_time) { 12.345 }

  describe '#initialize' do
    it 'sets name and remaining_time and formats message' do
      error = described_class.new(name, remaining_time)
      expect(error.name).to eq(name)
      expect(error.remaining_time).to eq(remaining_time)
      expect(error.message).to eq("Circuit breaker 'service_a' is open. Retry after 12.35s")
    end
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
    context 'with default values' do
      let(:config) { described_class.new }

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
      let(:config) do
        described_class.new(
          failure_threshold: 10,
          success_threshold: 2,
          timeout_seconds: 5.0,
          half_open_max_calls: 1,
          sliding_window_size: 20,
          failure_rate_threshold: 0.8
        )
      end

      it 'sets custom failure_threshold' do
        expect(config.failure_threshold).to eq(10)
      end

      it 'sets custom success_threshold' do
        expect(config.success_threshold).to eq(2)
      end

      it 'sets custom timeout_seconds' do
        expect(config.timeout_seconds).to eq(5.0)
      end

      it 'sets custom half_open_max_calls' do
        expect(config.half_open_max_calls).to eq(1)
      end

      it 'sets custom sliding_window_size' do
        expect(config.sliding_window_size).to eq(20)
      end

      it 'sets custom failure_rate_threshold' do
        expect(config.failure_rate_threshold).to eq(0.8)
      end
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments successful_calls and total_calls and sets last_success_time' do
      start_time = Time.now
      metrics.record_success(0.1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).to be >= start_time
      expect(metrics.last_failure_time).to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments failed_calls and total_calls and sets last_failure_time' do
      start_time = Time.now
      metrics.record_failure(0.2)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).to be >= start_time
      expect(metrics.last_success_time).to be_nil
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      metrics.record_rejection
      metrics.record_rejection
      expect(metrics.rejected_calls).to eq(2)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions' do
      metrics.record_state_transition
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(2)
    end
  end

  describe '#average_response_time' do
    context 'when there are no response times' do
      it 'returns 0' do
        expect(metrics.average_response_time).to eq(0)
      end
    end

    context 'when there are response times' do
      it 'returns the average duration' do
        metrics.record_success(0.1)
        metrics.record_failure(0.3)
        avg = metrics.average_response_time
        expect(avg).to be_within(0.0001).of(0.2)
      end
    end

    it 'limits stored response times to max_response_times' do
      150.times do
        metrics.record_success(0.01)
      end
      expect(metrics.send(:instance_variable_get, :@response_times).size).to eq(100)
    end
  end

  describe '#to_h' do
    it 'returns a hash with metrics data' do
      metrics.record_success(0.1)
      metrics.record_failure(0.2)
      metrics.record_rejection
      metrics.record_state_transition

      hash = metrics.to_h
      expect(hash[:total_calls]).to eq(2)
      expect(hash[:successful_calls]).to eq(1)
      expect(hash[:failed_calls]).to eq(1)
      expect(hash[:rejected_calls]).to eq(1)
      expect(hash[:state_transitions]).to eq(1)
      expect(hash[:average_response_time_ms]).to be_a(Float)
      expect(hash[:last_failure_time]).to be_a(String)
      expect(hash[:last_success_time]).to be_a(String)
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
  let(:name) { 'test_service' }
  let(:breaker) { described_class.new(name, config: config) }

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
      b1 = described_class.get_or_create('service_config_test', config: custom_config)
      expect(b1.config.failure_threshold).to eq(10)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry hash' do
      b1 = described_class.get_or_create('registry_service')
      registry = described_class.registry
      expect(registry['registry_service']).to eq(b1)
      registry['registry_service'] = nil
      expect(described_class.registry['registry_service']).to eq(b1)
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
      it 'executes the block and records success' do
        result = breaker.execute do
          42
        end
        expect(result).to eq(42)
        expect(breaker.metrics.successful_calls).to eq(1)
        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'records failure and may open circuit based on threshold' do
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
        end.to raise_error(CircuitBreaker::OpenError) do |error|
          expect(error.name).to eq(name)
          expect(error.remaining_time).to be >= 0
        end
        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'calls fallback when provided' do
        fallback = proc { :fallback_value }
        result = breaker.execute(fallback: fallback) do
          should_not_run
        end
        expect(result).to eq(:fallback_value)
        expect(breaker.metrics.rejected_calls).to eq(1)
      end
    end

    context 'when circuit transitions to half-open and then closed' do
      before do
        2.times do
          breaker.execute do
            raise 'failure'
          end
        rescue RuntimeError
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        allow(Time).to receive(:now).and_return(Time.now + 1)
      end

      it 'allows limited calls in half-open and closes after enough successes' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
        2.times do
          breaker.execute do
            ok
          end
        end
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'reopens circuit on failure in half-open' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
        expect do
          breaker.execute do
            raise 'half-open failure'
          end
        end.to raise_error(RuntimeError, 'half-open failure')
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'limits number of calls in half-open state' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
        2.times do
          breaker.execute do
            ok
          end
        end
        expect do
          breaker.execute do
            should_be_rejected
          end
        end.to raise_error(CircuitBreaker::OpenError)
      end
    end
  end

  describe '#state' do
    it 'returns CLOSED initially' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to HALF_OPEN after timeout from OPEN' do
      2.times do
        breaker.execute do
          raise 'failure'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      opened_at = breaker.send(:instance_variable_get, :@opened_at)
      allow(Time).to receive(:now).and_return(opened_at + config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns a hash with health information' do
      breaker.execute do
        ok
      end
      info = breaker.health_info
      expect(info[:name]).to eq(name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:failure_count]).to be_a(Integer)
      expect(info[:success_count]).to be_a(Integer)
      expect(info[:failure_rate]).to be_a(Float)
      expect(info[:metrics]).to be_a(Hash)
      expect(info[:config]).to include(
        failure_threshold: config.failure_threshold,
        success_threshold: config.success_threshold,
        timeout_seconds: config.timeout_seconds
      )
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.test' }
  let(:sync_interval) { 0.01 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }
  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('service_a', config: config) }

  describe '#register' do
    it 'stores breaker and sends registration request' do
      uri = URI("#{coordinator_url}/circuit-breakers/register")
      http_double = instance_double(Net::HTTP)
      request_double = instance_double(Net::HTTP::Post)

      allow(URI).to receive(:parse).and_call_original
      allow(URI).to receive(:parse).with(uri.to_s).and_return(uri)
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      allow(Net::HTTP::Post).to receive(:new).with(uri).and_return(request_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(request_double).to receive(:[]=)
      allow(request_double).to receive(:body=)
      allow(http_double).to receive(:request)

      coordinator.register(breaker)

      breakers = coordinator.instance_variable_get(:@breakers)
      expect(breakers['service_a']).to eq(breaker)
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts and stops synchronization thread' do
      expect(Thread).to receive(:new).and_call_original
      coordinator.register(breaker)
      coordinator.start_sync
      sleep(sync_interval * 2)
      coordinator.stop_sync
      sync_thread = coordinator.instance_variable_get(:@sync_thread)
      expect(sync_thread).to be_nil.or be_a(Thread)
    end
  end

  describe '#get_cluster_state' do
    let(:response_double) { instance_double(Net::HTTPResponse, body: '{"state":"OK"}') }

    it 'fetches and parses cluster state' do
      uri = URI("#{coordinator_url}/circuit-breakers/service_a/aggregate")
      allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response_double)
      state = coordinator.get_cluster_state('service_a')
      expect(state).to eq('state' => 'OK')
    end

    it 'returns error hash when request fails' do
      uri = URI("#{coordinator_url}/circuit-breakers/service_a/aggregate")
      allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('network error'))
      state = coordinator.get_cluster_state('service_a')
      expect(state[:error]).to eq('network error')
    end
  end

  describe 'private HTTP interactions' do
    let(:http_double) { instance_double(Net::HTTP) }
    let(:request_double) { instance_double(Net::HTTP::Post) }

    before do
      allow(Net::HTTP).to receive(:new).and_return(http_double)
      allow(Net::HTTP::Post).to receive(:new).and_return(request_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(request_double).to receive(:[]=)
      allow(request_double).to receive(:body=)
      allow(http_double).to receive(:request)
    end

    it 'handles errors in send_registration silently' do
      allow(http_double).to receive(:request).and_raise(StandardError.new('boom'))
      expect do
        coordinator.send(:send_registration, breaker)
      end.not_to raise_error
    end

    it 'handles errors in report_state silently' do
      allow(http_double).to receive(:request).and_raise(StandardError.new('boom'))
      expect do
        coordinator.send(:report_state, 'service_a', breaker)
      end.not_to raise_error
    end
  end
end
