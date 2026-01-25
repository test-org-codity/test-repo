require 'spec_helper'
require 'json'
require 'net/http'
require 'uri'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments successful_calls and total_calls and sets last_success_time' do
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.total_calls).to eq(0)
      metrics.record_success(0.01)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).to be_a(Time)
    end
  end

  describe '#record_failure' do
    it 'increments failed_calls and total_calls and sets last_failure_time' do
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.total_calls).to eq(0)
      metrics.record_failure(0.02)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
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
    it 'increments state transitions' do
      expect(metrics.state_transitions).to eq(0)
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when no data' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns average of recorded durations' do
      metrics.record_success(0.01)
      metrics.record_failure(0.03)
      avg = metrics.average_response_time
      expect(avg).to be_within(1e-6).of(0.02)
    end
  end

  describe '#to_h' do
    it 'returns a hash with expected keys without deadlocking by stubbing average_response_time' do
      metrics.record_success(0.05)
      metrics.record_failure(0.02)
      allow(metrics).to receive(:average_response_time).and_return(0.1234)
      result = metrics.to_h
      expect(result).to include(
        total_calls: 2,
        successful_calls: 1,
        failed_calls: 1,
        rejected_calls: 0,
        state_transitions: 0
      )
      expect(result[:average_response_time_ms]).to eq((0.1234 * 1000).round(2))
      expect(result[:last_failure_time]).to be_a(String)
      expect(result[:last_success_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 2,
      success_threshold: 2,
      timeout_seconds: 5.0,
      half_open_max_calls: 1,
      sliding_window_size: 4,
      failure_rate_threshold: 0.5
    )
  end
  let(:breaker) { described_class.new('test-service', config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('svc', config: config)
      b2 = described_class.get_or_create('svc', config: config)
      expect(b1.object_id).to eq(b2.object_id)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry including the breaker' do
      b = described_class.get_or_create('svc-registry', config: config)
      registry = described_class.registry
      expect(registry).to be_a(Hash)
      expect(registry['svc-registry']).to eq(b)
      expect(registry).not_to be(described_class.registry)
    end
  end

  describe '#execute' do
    context 'when closed' do
      it 'executes the block and records success' do
        result = breaker.execute do
          'ok'
        end
        expect(result).to eq('ok')
        expect(breaker.metrics.successful_calls).to eq(1)
        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end
    end

    context 'when block raises an error' do
      it 'records failure and re-raises the error' do
        expect do
          breaker.execute do
            raise StandardError, 'fail'
          end
        end.to raise_error(StandardError, 'fail')
        expect(breaker.metrics.failed_calls).to eq(1)
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'opens the circuit after reaching failure threshold' do
        expect do
          breaker.execute do
            raise 'boom1'
          end
        end.to raise_error(RuntimeError, 'boom1')
        expect do
          breaker.execute do
            raise 'boom2'
          end
        end.to raise_error(RuntimeError, 'boom2')
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end

    context 'when open' do
      before do
        2.times do
          breaker.execute do
            raise 'oops'
          end
        rescue StandardError
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'raises OpenError without fallback' do
        expect do
          breaker.execute do
            'should not run'
          end
        end.to raise_error(CircuitBreaker::OpenError) do |e|
          expect(e.name).to eq('test-service')
          expect(e.remaining_time).to be >= 0
          expect(e.remaining_time).to be <= config.timeout_seconds
        end
        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'returns fallback when provided' do
        result = breaker.execute(fallback: -> { 'fallback' }) do
          'should not run'
        end
        expect(result).to eq('fallback')
        expect(breaker.metrics.rejected_calls).to eq(1)
      end
    end

    context 'half-open behavior' do
      before do
        2.times do
          breaker.execute do
            raise 'error'
          end
        rescue StandardError
        end
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        breaker.instance_variable_set(:@opened_at, Time.now - (config.timeout_seconds + 1))
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      end

      it 'allows up to half_open_max_calls and then rejects further calls until reset window' do
        called = breaker.execute do
          'trial-ok'
        end
        expect(called).to eq('trial-ok')
        expect do
          breaker.execute do
            'should be rejected'
          end
        end.to raise_error(CircuitBreaker::OpenError)
      end

      it 'closes after reaching success_threshold successes' do
        c1 = breaker.execute do
          'ok1'
        end
        expect(c1).to eq('ok1')
        breaker.instance_variable_set(:@half_open_calls, 0)
        c2 = breaker.execute do
          'ok2'
        end
        expect(c2).to eq('ok2')
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'reopens on a failure in half-open' do
        expect do
          breaker.execute do
            raise 'trial-fail'
          end
        end.to raise_error(RuntimeError, 'trial-fail')
        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end

    context 'failure rate threshold triggers open' do
      let(:config) do
        CircuitBreaker::Config.new(
          failure_threshold: 10,
          success_threshold: 1,
          timeout_seconds: 60.0,
          half_open_max_calls: 1,
          sliding_window_size: 4,
          failure_rate_threshold: 0.5
        )
      end
      let(:breaker) { described_class.new('rate-service', config: config) }

      it 'opens when failure rate in the sliding window exceeds threshold' do
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
    end
  end

  describe '#state' do
    it 'transitions to HALF_OPEN when timeout has elapsed' do
      2.times do
        breaker.execute do
          raise 'err'
        end
      rescue StandardError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      breaker.instance_variable_set(:@opened_at, Time.now - (config.timeout_seconds + 0.1))
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns a structured hash with service info without deadlocking' do
      allow(breaker.metrics).to receive(:to_h).and_return({ dummy: true })
      info = breaker.health_info
      expect(info[:name]).to eq('test-service')
      expect(info[:state]).to be_a(String)
      expect(info[:config]).to include(
        failure_threshold: config.failure_threshold,
        success_threshold: config.success_threshold,
        timeout_seconds: config.timeout_seconds
      )
      expect(info[:metrics]).to eq({ dummy: true })
    end
  end

  describe '#execute without block' do
    it 'raises ArgumentError when no block given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError, 'Block required')
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.local' }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: 0.01) }
  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('svc-a', config: config) }

  def stub_net_http_request
    http = instance_double(Net::HTTP)
    response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(response)
    [http, response]
  end

  describe '#register' do
    it 'stores the breaker and sends registration request' do
      http, _response = stub_net_http_request
      expect(http).to receive(:request) do |req|
        expect(req).to be_a(Net::HTTP::Post)
        expect(req['Content-Type']).to eq('application/json')
        body = JSON.parse(req.body)
        expect(body['service']).to eq('svc-a')
        expect(body['node_id']).to be_a(String)
        expect(body['failure_threshold']).to eq(config.failure_threshold)
        expect(body['success_threshold']).to eq(config.success_threshold)
        instance_double(Net::HTTPResponse, body: '{"ok":true}')
      end
      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end

    it 'does not raise on network errors' do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(StandardError.new('net down'))
      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background thread that reports state periodically' do
      coordinator.register(breaker)
      http, _response = stub_net_http_request
      allow(coordinator).to receive(:report_state).and_return(nil)
      coordinator.start_sync
      sleep 0.03
      coordinator.stop_sync
      expect(coordinator).to have_received(:report_state).at_least(:once)
      expect(http).to have_received(:open_timeout=).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON from coordinator' do
      uri = URI("#{coordinator_url}/circuit-breakers/svc-a/aggregate")
      response = instance_double(Net::HTTPResponse, body: '{"status":"ok","count":1}')
      allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)
      result = coordinator.get_cluster_state('svc-a')
      expect(result).to eq({ 'status' => 'ok', 'count' => 1 })
    end

    it 'returns error hash on exceptions' do
      uri = URI("#{coordinator_url}/circuit-breakers/svc-a/aggregate")
      allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('boom'))
      result = coordinator.get_cluster_state('svc-a')
      expect(result).to include(:error)
      expect(result[:error]).to eq('boom')
    end
  end
end
