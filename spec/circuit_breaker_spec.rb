require 'spec_helper'
require 'json'
require 'time'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states as symbols' do
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
    let(:config) do
      described_class.new(
        failure_threshold: 7,
        success_threshold: 4,
        timeout_seconds: 2.5,
        half_open_max_calls: 2,
        sliding_window_size: 20,
        failure_rate_threshold: 0.3
      )
    end

    it 'sets the provided configuration values' do
      expect(config.failure_threshold).to eq(7)
      expect(config.success_threshold).to eq(4)
      expect(config.timeout_seconds).to eq(2.5)
      expect(config.half_open_max_calls).to eq(2)
      expect(config.sliding_window_size).to eq(20)
      expect(config.failure_rate_threshold).to eq(0.3)
    end

    it 'uses defaults when not provided' do
      default_config = described_class.new
      expect(default_config.failure_threshold).to eq(5)
      expect(default_config.success_threshold).to eq(3)
      expect(default_config.timeout_seconds).to eq(30.0)
      expect(default_config.half_open_max_calls).to eq(3)
      expect(default_config.sliding_window_size).to eq(10)
      expect(default_config.failure_rate_threshold).to eq(0.5)
    end
  end
end

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name and remaining_time and formats message' do
      error = described_class.new('service-x', 1.234)
      expect(error.name).to eq('service-x')
      expect(error.remaining_time).to be_within(0.01).of(1.234)
      expect(error.message).to include("Circuit breaker 'service-x' is open.")
      expect(error.message).to include('Retry after')
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  subject(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments success and totals and updates last_success_time' do
      metrics.record_success(0.01)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).to be_a(Time)
    end
  end

  describe '#record_failure' do
    it 'increments failure and totals and updates last_failure_time' do
      metrics.record_failure(0.02)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).to be_a(Time)
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      metrics.record_rejection
      expect(metrics.rejected_calls).to eq(1)
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

    it 'computes the average response time over recorded durations' do
      metrics.record_success(0.010)
      metrics.record_failure(0.030)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.020)
    end
  end

  describe '#to_h' do
    it 'returns a hash of metrics with computed average in ms' do
      allow(metrics).to receive(:average_response_time).and_return(0.12345)
      metrics.record_success(0.01)
      metrics.record_failure(0.02)
      metrics.record_rejection
      metrics.record_state_transition

      h = metrics.to_h
      expect(h[:total_calls]).to eq(2)
      expect(h[:successful_calls]).to eq(1)
      expect(h[:failed_calls]).to eq(1)
      expect(h[:rejected_calls]).to eq(1)
      expect(h[:state_transitions]).to eq(1)
      expect(h[:average_response_time_ms]).to eq((0.12345 * 1000).round(2))
      expect(h[:last_failure_time]).to be_a(String)
      expect(h[:last_success_time]).to be_a(String)
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
  let(:breaker) { described_class.new('service-a', config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('shared', config: config)
      b2 = described_class.get_or_create('shared', config: config)
      expect(b1).to be(b2)
    end
  end

  describe '.registry' do
    it 'contains breakers created via get_or_create' do
      name = "svc-#{rand(10_000)}"
      b = described_class.get_or_create(name, config: config)
      reg = described_class.registry
      expect(reg[name]).to be(b)
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'records failure and re-raises the error on exception' do
      expect do
        breaker.execute do
          raise 'fail'
        end
      end.to raise_error(RuntimeError, 'fail')
      expect(breaker.metrics.failed_calls).to eq(1)
    end

    it 'invokes fallback when circuit is open' do
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

      result = breaker.execute(fallback: -> { :fallback_value }) do
        should_not_run
      end
      expect(result).to eq(:fallback_value)
      expect(breaker.metrics.rejected_calls).to be >= 1
    end

    it 'raises OpenError when circuit is open and no fallback' do
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

      expect do
        breaker.execute do
          not_run
        end
      end.to raise_error(CircuitBreaker::OpenError)
    end
  end

  describe '#state transitions' do
    it 'moves to OPEN after reaching failure_threshold' do
      expect do
        breaker.execute do
          raise 'boom1'
        end
      end.to raise_error(RuntimeError)

      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

      expect do
        breaker.execute do
          raise 'boom2'
        end
      end.to raise_error(RuntimeError)

      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'moves to HALF_OPEN after timeout elapses' do
      2.times do
        expect do
          breaker.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep 0.12
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns health info including config and metrics' do
      allow(breaker.metrics).to receive(:average_response_time).and_return(0.0)
      info = breaker.health_info
      expect(info[:name]).to eq('service-a')
      expect(info[:state]).to be_a(String)
      expect(info[:failure_count]).to be_a(Integer)
      expect(info[:success_count]).to be_a(Integer)
      expect(info[:failure_rate]).to be_a(Float)
      expect(info[:metrics]).to be_a(Hash)
      expect(info[:config]).to include(:failure_threshold, :success_threshold, :timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:base_url) { 'http://coordinator.local' }
  let(:coordinator) { described_class.new(base_url, sync_interval: 0.01) }
  let(:config) { CircuitBreaker::Config.new }
  let(:breaker) { CircuitBreaker::Breaker.new('svc-dc', config: config) }

  def stub_http_request(expected_path:)
    uri = URI("#{base_url}#{expected_path}")
    http = instance_double(Net::HTTP)
    response = instance_double(Net::HTTPResponse)
    allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(response)
    [http, response]
  end

  describe '#register' do
    it 'sends registration to coordinator' do
      http, _response = stub_http_request(expected_path: '/circuit-breakers/register')
      expect(http).to receive(:request).at_least(:once)
      coordinator.register(breaker)
    end

    it 'stores breaker reference for synchronization' do
      allow(coordinator).to receive(:send_registration)
      coordinator.register(breaker)
      allow(coordinator).to receive(:report_state)
      coordinator.start_sync
      sleep 0.02
      coordinator.stop_sync
      expect(coordinator).to have_received(:report_state).at_least(:once)
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background thread and reports state periodically' do
      allow(coordinator).to receive(:report_state)
      allow(coordinator).to receive(:send_registration)
      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.03
      coordinator.stop_sync
      expect(coordinator).to have_received(:report_state).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON on success' do
      uri = URI("#{base_url}/circuit-breakers/#{breaker.name}/aggregate")
      response = instance_double(Net::HTTPResponse, body: { status: 'ok', nodes: 2 }.to_json)
      allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)
      result = coordinator.get_cluster_state(breaker.name)
      expect(result).to eq('status' => 'ok', 'nodes' => 2)
    end

    it 'returns error hash on failure' do
      uri = URI("#{base_url}/circuit-breakers/#{breaker.name}/aggregate")
      allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('network error'))
      result = coordinator.get_cluster_state(breaker.name)
      expect(result).to include(:error)
      expect(result[:error]).to include('network error')
    end
  end

  describe 'private HTTP interactions' do
    it 'report_state sends state payload' do
      http, _response = stub_http_request(expected_path: '/circuit-breakers/state')
      expect(http).to receive(:request).at_least(:once)
      allow(breaker.metrics).to receive(:average_response_time).and_return(0.0)
      coordinator.send(:report_state, breaker.name, breaker)
    end
  end
end
