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

  it 'exposes the name' do
    expect(error.name).to eq(name)
  end

  it 'exposes the remaining_time' do
    expect(error.remaining_time).to eq(remaining_time)
  end

  it 'builds a descriptive message including rounded remaining time' do
    expect(error.message).to eq("Circuit breaker 'service_a' is open. Retry after 12.35s")
  end
end

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all defined states' do
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
          success_threshold: 4,
          timeout_seconds: 5.5,
          half_open_max_calls: 2,
          sliding_window_size: 20,
          failure_rate_threshold: 0.8
        )
      end

      it 'assigns custom failure_threshold' do
        expect(config.failure_threshold).to eq(10)
      end

      it 'assigns custom success_threshold' do
        expect(config.success_threshold).to eq(4)
      end

      it 'assigns custom timeout_seconds' do
        expect(config.timeout_seconds).to eq(5.5)
      end

      it 'assigns custom half_open_max_calls' do
        expect(config.half_open_max_calls).to eq(2)
      end

      it 'assigns custom sliding_window_size' do
        expect(config.sliding_window_size).to eq(20)
      end

      it 'assigns custom failure_rate_threshold' do
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
      it 'returns the average duration' do
        metrics.record_success(0.1)
        metrics.record_failure(0.3)
        expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
      end
    end
  end

  describe '#to_h' do
    it 'returns a hash with metrics information' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      metrics.record_rejection
      metrics.record_state_transition

      result = metrics.to_h

      expect(result[:total_calls]).to eq(2)
      expect(result[:successful_calls]).to eq(1)
      expect(result[:failed_calls]).to eq(1)
      expect(result[:rejected_calls]).to eq(1)
      expect(result[:state_transitions]).to eq(1)
      expect(result[:average_response_time_ms]).to be_a(Float)
      expect(result[:last_failure_time]).to be_a(String)
      expect(result[:last_success_time]).to be_a(String)
    end
  end

  describe 'response time window' do
    it 'keeps at most 100 response times for average calculation' do
      150.times do |i|
        metrics.record_success(0.001 * i)
      end

      expect(metrics.instance_variable_get(:@response_times).size).to eq(100)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 3,
      success_threshold: 2,
      timeout_seconds: 1.0,
      half_open_max_calls: 2,
      sliding_window_size: 4,
      failure_rate_threshold: 0.75
    )
  end

  let(:name) { 'test_service' }
  subject(:breaker) { described_class.new(name, config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('service1', config: config)
      b2 = described_class.get_or_create('service1', config: config)
      expect(b1).to be(b2)
    end

    it 'returns different instances for different names' do
      b1 = described_class.get_or_create('service_a', config: config)
      b2 = described_class.get_or_create('service_b', config: config)
      expect(b1).not_to be(b2)
    end
  end

  describe '.registry' do
    it 'returns a duplicate of the registry hash' do
      described_class.get_or_create('registry_test', config: config)
      registry = described_class.registry
      expect(registry).to be_a(Hash)
      expect(registry['registry_test']).to be_a(described_class)
    end
  end

  describe '#initialize' do
    it 'sets the name and config' do
      expect(breaker.name).to eq(name)
      expect(breaker.config).to eq(config)
    end

    it 'initializes state to CLOSED' do
      expect(breaker.send(:state)).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'initializes metrics' do
      expect(breaker.metrics).to be_a(CircuitBreaker::Metrics)
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

    context 'when circuit is CLOSED' do
      it 'executes the block and returns result on success' do
        result = breaker.execute do
          42
        end
        expect(result).to eq(42)
        expect(breaker.metrics.successful_calls).to eq(1)
      end

      it 'records failure and re-raises error on exception' do
        expect do
          breaker.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError, 'boom')
        expect(breaker.metrics.failed_calls).to eq(1)
      end
    end

    context 'when circuit is OPEN' do
      before do
        3.times do
          begin
            breaker.execute do
              raise 'failure'
            end
          rescue RuntimeError
          end
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'invokes fallback when provided and records rejection' do
        fallback = double('fallback')
        allow(fallback).to receive(:call).and_return('fallback_result')

        result = breaker.execute(fallback: fallback) do
          1
        end

        expect(result).to eq('fallback_result')
        expect(fallback).to have_received(:call)
        expect(breaker.metrics.rejected_calls).to eq(1)
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
        expect(breaker.metrics.rejected_calls).to eq(1)
      end
    end

    context 'when circuit transitions from OPEN to HALF_OPEN after timeout' do
      before do
        3.times do
          begin
            breaker.execute do
              raise 'failure'
            end
          rescue RuntimeError
          end
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_call_original
        opened_at = breaker.instance_variable_get(:@opened_at)
        allow(Time).to receive(:now).and_return(opened_at + config.timeout_seconds + 0.1)
      end

      it 'allows limited calls in HALF_OPEN state and closes on enough successes' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        result1 = breaker.execute do
          'ok1'
        end
        result2 = breaker.execute do
          'ok2'
        end

        expect(result1).to eq('ok1')
        expect(result2).to eq('ok2')
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 're-opens the circuit on failure in HALF_OPEN' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute do
            raise 'half-open failure'
          end
        end.to raise_error(RuntimeError, 'half-open failure')

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'limits number of allowed calls in HALF_OPEN' do
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        2.times do
          breaker.execute do
            'ok'
          end
        end

        expect do
          breaker.execute do
            'extra'
          end
        end.to raise_error(CircuitBreaker::OpenError)

        expect(breaker.metrics.rejected_calls).to be >= 1
      end
    end
  end

  describe '#state' do
    it 'returns CLOSED by default' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to HALF_OPEN when timeout expires from OPEN' do
      3.times do
        begin
          breaker.execute do
            raise 'failure'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      allow(Time).to receive(:now).and_call_original
      opened_at = breaker.instance_variable_get(:@opened_at)
      allow(Time).to receive(:now).and_return(opened_at + config.timeout_seconds + 0.1)

      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns a hash with health and configuration information' do
      breaker.execute do
        1
      end

      health = breaker.health_info

      expect(health[:name]).to eq(name)
      expect(health[:state]).to eq('CLOSED')
      expect(health[:failure_count]).to be_a(Integer)
      expect(health[:success_count]).to be_a(Integer)
      expect(health[:failure_rate]).to be_a(Float)
      expect(health[:metrics]).to be_a(Hash)
      expect(health[:config]).to include(
        failure_threshold: config.failure_threshold,
        success_threshold: config.success_threshold,
        timeout_seconds: config.timeout_seconds
      )
    end
  end

  describe 'failure rate and threshold behavior' do
    it 'opens circuit when failure count exceeds threshold' do
      3.times do
        begin
          breaker.execute do
            raise 'failure'
          end
        rescue RuntimeError
        end
      end

      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'opens circuit when failure rate exceeds threshold even if count is lower' do
      custom_config = CircuitBreaker::Config.new(
        failure_threshold: 10,
        success_threshold: 2,
        timeout_seconds: 10.0,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
      custom_breaker = described_class.new('rate_test', config: custom_config)

      begin
        custom_breaker.execute do
          raise 'failure1'
        end
      rescue RuntimeError
      end

      custom_breaker.execute do
        'success'
      end

      begin
        custom_breaker.execute do
          raise 'failure2'
        end
      rescue RuntimeError
      end

      begin
        custom_breaker.execute do
          raise 'failure3'
        end
      rescue RuntimeError
      end

      expect(custom_breaker.state).to eq(CircuitBreaker::State::OPEN)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.test' }
  let(:sync_interval) { 0.01 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }

  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('service_x', config: config) }

  describe '#initialize' do
    it 'sets coordinator_url and sync_interval' do
      expect(coordinator.instance_variable_get(:@coordinator_url)).to eq(coordinator_url)
      expect(coordinator.instance_variable_get(:@sync_interval)).to eq(sync_interval)
    end

    it 'sets node_id based on ENV or process pid' do
      node_id = coordinator.instance_variable_get(:@node_id)
      expect(node_id).to be_a(String)
      expect(node_id).to include('ruby-')
    end
  end

  describe '#register' do
    let(:http_double) { instance_double(Net::HTTP, request: nil) }

    before do
      allow(Net::HTTP).to receive(:new).and_return(http_double)
    end

    it 'stores breaker and sends registration' do
      coordinator.register(breaker)

      breakers = coordinator.instance_variable_get(:@breakers)
      expect(breakers['service_x']).to eq(breaker)
      expect(Net::HTTP).to have_received(:new)
    end

    it 'swallows errors during registration' do
      allow(Net::HTTP).to receive(:new).and_raise(StandardError.new('network error'))

      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    let(:http_double) { instance_double(Net::HTTP, request: nil) }

    before do
      allow(Net::HTTP).to receive(:new).and_return(http_double)
      coordinator.register(breaker)
    end

    it 'starts a background thread that calls synchronize_states' do
      expect(coordinator.instance_variable_get(:@sync_thread)).to be_nil

      coordinator.start_sync
      sleep(sync_interval * 3)
      coordinator.stop_sync

      expect(coordinator.instance_variable_get(:@sync_thread)).not_to be_nil
      expect(Net::HTTP).to have_received(:new).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    let(:response_double) { instance_double(Net::HTTPResponse, body: '{"state":"OPEN"}') }

    before do
      allow(Net::HTTP).to receive(:get_response).and_return(response_double)
    end

    it 'calls coordinator aggregate endpoint and parses JSON' do
      result = coordinator.get_cluster_state('service_y')
      expect(result).to eq('state' => 'OPEN')
      expect(Net::HTTP).to have_received(:get_response) do |uri|
        expect(uri.to_s).to eq("#{coordinator_url}/circuit-breakers/service_y/aggregate")
      end
    end

    it 'returns error hash on exceptions' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('boom'))

      result = coordinator.get_cluster_state('service_y')
      expect(result).to include(:error)
      expect(result[:error]).to eq('boom')
    end
  end

  describe 'private HTTP reporting behavior' do
    let(:http_double) { instance_double(Net::HTTP, request: nil) }

    before do
      allow(Net::HTTP).to receive(:new).and_return(http_double)
      coordinator.register(breaker)
    end

    it 'sends state reports without raising errors' do
      expect do
        coordinator.send(:synchronize_states)
      end.not_to raise_error
      expect(Net::HTTP).to have_received(:new).at_least(:once)
    end

    it 'swallows errors during reporting' do
      allow(Net::HTTP).to receive(:new).and_raise(StandardError.new('network error'))

      expect do
        coordinator.send(:synchronize_states)
      end.not_to raise_error
    end
  end
end
