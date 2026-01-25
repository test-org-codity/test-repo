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
    context 'with defaults' do
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
          failure_threshold: 2,
          success_threshold: 4,
          timeout_seconds: 10.0,
          half_open_max_calls: 5,
          sliding_window_size: 20,
          failure_rate_threshold: 0.7
        )
      end

      it 'sets custom failure_threshold' do
        expect(config.failure_threshold).to eq(2)
      end

      it 'sets custom success_threshold' do
        expect(config.success_threshold).to eq(4)
      end

      it 'sets custom timeout_seconds' do
        expect(config.timeout_seconds).to eq(10.0)
      end

      it 'sets custom half_open_max_calls' do
        expect(config.half_open_max_calls).to eq(5)
      end

      it 'sets custom sliding_window_size' do
        expect(config.sliding_window_size).to eq(20)
      end

      it 'sets custom failure_rate_threshold' do
        expect(config.failure_rate_threshold).to eq(0.7)
      end
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments successful_calls and total_calls and sets last_success_time' do
      expect do
        metrics.record_success(0.1)
      end.to change { metrics.successful_calls }.by(1)
                                                .and change { metrics.total_calls }.by(1)
      expect(metrics.last_success_time).to be_within(1).of(Time.now)
    end
  end

  describe '#record_failure' do
    it 'increments failed_calls and total_calls and sets last_failure_time' do
      expect do
        metrics.record_failure(0.2)
      end.to change { metrics.failed_calls }.by(1)
                                            .and change { metrics.total_calls }.by(1)
      expect(metrics.last_failure_time).to be_within(1).of(Time.now)
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
    it 'returns 0 when there are no response times' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns the average of recorded durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
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
      expect(hash[:last_success_time]).to be_a(String)
      expect(hash[:last_failure_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 2,
      timeout_seconds: 0.5,
      half_open_max_calls: 2,
      sliding_window_size: 4,
      failure_rate_threshold: 0.5
    )
  end
  let(:name) { 'test_service' }
  let(:breaker) { described_class.new(name, config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('service_x')
      b2 = described_class.get_or_create('service_x')
      expect(b1).to be(b2)
    end

    it 'creates different instances for different names' do
      b1 = described_class.get_or_create('service_y')
      b2 = described_class.get_or_create('service_z')
      expect(b1).not_to be(b2)
    end

    it 'uses provided config on first creation' do
      custom_config = CircuitBreaker::Config.new(failure_threshold: 10)
      b1 = described_class.get_or_create('service_cfg', config: custom_config)
      b2 = described_class.get_or_create('service_cfg')
      expect(b1.config.failure_threshold).to eq(10)
      expect(b2.config.failure_threshold).to eq(10)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry hash' do
      described_class.get_or_create('service_registry_test')
      registry = described_class.registry
      expect(registry).to be_a(Hash)
      expect(registry.keys).to include('service_registry_test')
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
      it 'executes the block and returns its result' do
        value = breaker.execute do
          'success'
        end
        expect(value).to eq('success')
        expect(breaker.health_info[:state]).to eq('CLOSED')
      end

      it 'records success metrics' do
        expect do
          breaker.execute do
            'success'
          end
        end.to change { breaker.metrics.successful_calls }.by(1)
                                                          .and change { breaker.metrics.total_calls }.by(1)
      end

      it 'records failure metrics and re-raises error' do
        expect do
          breaker.execute do
            raise StandardError, 'boom'
          end
        end.to raise_error(StandardError, 'boom')
        expect(breaker.metrics.failed_calls).to eq(1)
        expect(breaker.metrics.total_calls).to eq(1)
      end
    end

    context 'when failures exceed threshold' do
      before do
        2.times do
          breaker.execute do
            raise StandardError, 'failure'
          end
        rescue StandardError
        end
      end

      it 'opens the circuit' do
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'rejects further calls and raises OpenError without fallback' do
        expect do
          breaker.execute do
            'should_not_run'
          end
        end.to raise_error(CircuitBreaker::OpenError)
        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'calls fallback when provided instead of raising' do
        fallback = proc do
          'fallback_value'
        end
        value = breaker.execute(fallback: fallback) do
          'should_not_run'
        end
        expect(value).to eq('fallback_value')
        expect(breaker.metrics.rejected_calls).to eq(2)
      end
    end

    context 'when circuit is half-open' do
      before do
        2.times do
          breaker.execute do
            raise StandardError, 'failure'
          end
        rescue StandardError
        end
        allow(Time).to receive(:now).and_return(Time.now + 1)
        breaker.state
      end

      it 'allows limited number of calls' do
        calls = 0
        3.times do
          breaker.execute do
            calls += 1
            'ok'
          end
        rescue CircuitBreaker::OpenError
        end
        expect(calls).to eq(2)
      end

      it 'closes circuit after enough successes' do
        2.times do
          breaker.execute do
            'success'
          end
        end
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'reopens circuit on failure' do
        expect do
          breaker.execute do
            raise StandardError, 'half_open_failure'
          end
        end.to raise_error(StandardError, 'half_open_failure')
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end
  end

  describe '#state' do
    it 'returns CLOSED initially' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to HALF_OPEN after timeout when open' do
      2.times do
        breaker.execute do
          raise StandardError, 'failure'
        end
      rescue StandardError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      opened_at = Time.now
      allow(Time).to receive(:now).and_return(opened_at)
      breaker.instance_variable_set(:@opened_at, opened_at)
      allow(Time).to receive(:now).and_return(opened_at + config.timeout_seconds + 0.1)

      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns a hash with breaker health information' do
      info = breaker.health_info
      expect(info[:name]).to eq(name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:failure_count]).to eq(0)
      expect(info[:success_count]).to eq(0)
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
  let(:coordinator_url) { 'http://coordinator.example.com' }
  let(:sync_interval) { 0.01 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }
  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('service_a', config: config) }

  describe '#register' do
    it 'stores breaker and sends registration' do
      http_double = instance_double(Net::HTTP)
      response_double = instance_double(Net::HTTPResponse)

      uri = URI("#{coordinator_url}/circuit-breakers/register")
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(response_double)

      coordinator.register(breaker)

      internal_breakers = coordinator.instance_variable_get(:@breakers)
      expect(internal_breakers['service_a']).to eq(breaker)
      expect(http_double).to have_received(:request).once
    end

    it 'swallows errors from registration' do
      uri = URI("#{coordinator_url}/circuit-breakers/register")
      http_double = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_raise(StandardError, 'network error')

      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts and stops background sync thread' do
      http_double = instance_double(Net::HTTP)
      response_double = instance_double(Net::HTTPResponse)
      uri = URI("#{coordinator_url}/circuit-breakers/state")
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(response_double)

      coordinator.register(breaker)
      coordinator.start_sync
      sleep(sync_interval * 3)
      coordinator.stop_sync

      expect(coordinator.instance_variable_get(:@running)).to eq(false)
    end
  end

  describe '#get_cluster_state' do
    let(:service_name) { 'service_a' }
    let(:uri) { URI("#{coordinator_url}/circuit-breakers/#{service_name}/aggregate") }

    it 'returns parsed JSON on success' do
      response_double = instance_double(Net::HTTPResponse, body: '{"state":"OK"}')
      allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response_double)

      result = coordinator.get_cluster_state(service_name)
      expect(result).to eq('state' => 'OK')
    end

    it 'returns error hash on failure' do
      allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError, 'timeout')

      result = coordinator.get_cluster_state(service_name)
      expect(result[:error]).to eq('timeout')
    end
  end

  describe 'state reporting internals' do
    it 'swallows errors when reporting state' do
      coordinator.instance_variable_get(:@breakers)['service_a'] = breaker
      uri = URI("#{coordinator_url}/circuit-breakers/state")
      http_double = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_raise(StandardError, 'network error')

      expect do
        coordinator.send(:synchronize_states)
      end.not_to raise_error
    end
  end
end
