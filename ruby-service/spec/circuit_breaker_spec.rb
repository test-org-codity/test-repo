require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  let(:name) { 'service_a' }
  let(:remaining_time) { 12.345 }

  describe '#initialize' do
    it 'sets name and remaining_time and formats the message' do
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
    context 'when there are no response times' do
      it 'returns 0' do
        expect(metrics.average_response_time).to eq(0)
      end
    end

    context 'when there are response times' do
      it 'returns the average of recorded durations' do
        metrics.record_success(0.1)
        metrics.record_failure(0.3)
        expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
      end
    end

    context 'when more than max_response_times are recorded' do
      it 'keeps only the last max_response_times entries' do
        150.times do |i|
          metrics.record_success(0.001 * i)
        end
        avg = metrics.average_response_time
        expect(avg).to be > 0
      end
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
      b1 = described_class.get_or_create('service_custom', config: custom_config)
      expect(b1.config.failure_threshold).to eq(10)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry hash' do
      b1 = described_class.get_or_create('registry_service')
      registry = described_class.registry
      expect(registry).to be_a(Hash)
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
      it 'executes the block and returns its result' do
        result = breaker.execute do
          42
        end
        expect(result).to eq(42)
        expect(breaker.metrics.successful_calls).to eq(1)
      end

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

      it 'increments rejected_calls when request is not allowed' do
        expect do
          breaker.execute do
            1
          end
        rescue CircuitBreaker::OpenError
        end.to change { breaker.metrics.rejected_calls }.by(1)
      end

      it 'raises OpenError when no fallback is provided' do
        expect do
          breaker.execute do
            1
          end
        end.to raise_error(CircuitBreaker::OpenError) do |error|
          expect(error.name).to eq(name)
          expect(error.remaining_time).to be >= 0
        end
      end

      it 'calls fallback when provided and does not raise' do
        fallback = proc do
          fallback_value
        end
        result = breaker.execute(fallback: fallback) do
          1
        end
        expect(result).to eq(:fallback_value)
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

        results = []
        3.times do |_i|
          result = breaker.execute do
            ok
          end
          results << result
        rescue CircuitBreaker::OpenError
          results << :rejected
        end

        expect(results.count(:ok)).to eq(config.half_open_max_calls)
        expect(results).to include(:rejected)
      end
    end
  end

  describe '#state' do
    it 'returns CLOSED initially' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to OPEN after threshold failures' do
      2.times do
        breaker.execute do
          raise 'failure'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'transitions to HALF_OPEN after timeout' do
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
  let(:sync_interval) { 0.05 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }
  let(:breaker_config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('service_a', config: breaker_config) }

  before do
    allow(ENV).to receive(:[]).with('NODE_ID').and_return('test-node')
  end

  describe '#register' do
    let(:uri) { URI("#{coordinator_url}/circuit-breakers/register") }
    let(:http_double) { instance_double(Net::HTTP) }
    let(:response_double) { instance_double(Net::HTTPResponse) }

    before do
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(response_double)
    end

    it 'stores the breaker and sends registration to coordinator' do
      expect(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http_double)
      expect(http_double).to receive(:request) do |request|
        body = JSON.parse(request.body)
        expect(body['service']).to eq('service_a')
        expect(body['node_id']).to eq('test-node')
        expect(body['failure_threshold']).to eq(breaker_config.failure_threshold)
        expect(body['success_threshold']).to eq(breaker_config.success_threshold)
        response_double
      end

      coordinator.register(breaker)
    end

    it 'handles errors silently when sending registration' do
      allow(Net::HTTP).to receive(:new).and_raise(StandardError.new('network error'))
      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    let(:state_uri) { URI("#{coordinator_url}/circuit-breakers/state") }
    let(:http_double) { instance_double(Net::HTTP) }
    let(:response_double) { instance_double(Net::HTTPResponse) }

    before do
      allow(Net::HTTP).to receive(:new).with(state_uri.host, state_uri.port).and_return(http_double)
      allow(http_double).to receive(:open_timeout=)
      allow(http_double).to receive(:read_timeout=)
      allow(http_double).to receive(:request).and_return(response_double)
      coordinator.register(breaker)
    end

    it 'periodically reports breaker state while running' do
      expect(http_double).to receive(:request).at_least(:once)
      coordinator.start_sync
      sleep(sync_interval * 3)
      coordinator.stop_sync
    end

    it 'stops the sync thread on stop_sync' do
      coordinator.start_sync
      thread = coordinator.instance_variable_get(:@sync_thread)
      expect(thread).to be_a(Thread)
      coordinator.stop_sync
      thread.join(1)
      expect(thread.alive?).to eq(false)
    end
  end

  describe '#get_cluster_state' do
    let(:service_name) { 'service_a' }
    let(:uri) { URI("#{coordinator_url}/circuit-breakers/#{service_name}/aggregate") }
    let(:response_double) { instance_double(Net::HTTPResponse, body: '{"status":"ok"}') }

    context 'when request succeeds' do
      before do
        allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response_double)
      end

      it 'returns parsed JSON' do
        result = coordinator.get_cluster_state(service_name)
        expect(result).to eq('status' => 'ok')
      end
    end

    context 'when request raises an error' do
      before do
        allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('timeout'))
      end

      it 'returns a hash with error message' do
        result = coordinator.get_cluster_state(service_name)
        expect(result[:error]).to eq('timeout')
      end
    end
  end
end
