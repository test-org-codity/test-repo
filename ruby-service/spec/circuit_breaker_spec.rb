require 'spec_helper'
require 'json'
require 'net/http'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::Error do
  it 'inherits from StandardError' do
    err = described_class.new('oops')
    expect(err).to be_a(StandardError)
    expect(err.message).to eq('oops')
  end
end

RSpec.describe CircuitBreaker::OpenError do
  it 'exposes name and remaining_time and formats message' do
    error = described_class.new('svc', 1.2345)
    expect(error.name).to eq('svc')
    expect(error.remaining_time).to be_within(0.001).of(1.2345)
    expect(error.message).to include("Circuit breaker 'svc' is open")
    expect(error.message).to include('1.23')
  end
end

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all states including CLOSED, OPEN, HALF_OPEN' do
      all = described_class.all
      expect(all).to include(:closed, :open, :half_open)
      expect(all.uniq.size).to eq(all.size)
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'sets default values' do
      cfg = described_class.new
      expect(cfg.failure_threshold).to eq(5)
      expect(cfg.success_threshold).to eq(3)
      expect(cfg.timeout_seconds).to eq(30.0)
      expect(cfg.half_open_max_calls).to eq(3)
      expect(cfg.sliding_window_size).to eq(10)
      expect(cfg.failure_rate_threshold).to eq(0.5)
    end

    it 'accepts custom values' do
      cfg = described_class.new(
        failure_threshold: 2,
        success_threshold: 4,
        timeout_seconds: 1.5,
        half_open_max_calls: 2,
        sliding_window_size: 5,
        failure_rate_threshold: 0.75
      )
      expect(cfg.failure_threshold).to eq(2)
      expect(cfg.success_threshold).to eq(4)
      expect(cfg.timeout_seconds).to eq(1.5)
      expect(cfg.half_open_max_calls).to eq(2)
      expect(cfg.sliding_window_size).to eq(5)
      expect(cfg.failure_rate_threshold).to eq(0.75)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) do
    described_class.new
  end

  describe '#record_success' do
    it 'increments successful_calls and total_calls and sets last_success_time' do
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.total_calls).to eq(0)
      metrics.record_success(0.05)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).not_to be_nil
      expect(metrics.average_response_time).to be_within(0.0001).of(0.05)
    end
  end

  describe '#record_failure' do
    it 'increments failed_calls and total_calls and sets last_failure_time' do
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.total_calls).to eq(0)
      metrics.record_failure(0.1)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).not_to be_nil
      expect(metrics.average_response_time).to be_within(0.0001).of(0.1)
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
    it 'increments state_transitions' do
      expect(metrics.state_transitions).to eq(0)
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when no responses' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'averages multiple durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a summary hash without deadlocking and with ms conversion' do
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      # Ensure last times are nil to avoid Time#iso8601 dependency
      h = metrics.to_h
      expect(h[:total_calls]).to eq(0)
      expect(h[:successful_calls]).to eq(0)
      expect(h[:failed_calls]).to eq(0)
      expect(h[:rejected_calls]).to eq(0)
      expect(h[:state_transitions]).to eq(0)
      expect(h[:average_response_time_ms]).to eq(123.0)
      expect(h[:last_failure_time]).to be_nil
      expect(h[:last_success_time]).to be_nil
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
      failure_rate_threshold: 0.75
    )
  end

  let(:breaker_name) do
    "service-#{SecureRandom.hex(4)}"
  end

  let(:breaker) do
    described_class.new(breaker_name, config: config)
  end

  before do
    described_class.class_variable_set(:@@registry, {})
  end

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('svc-a', config: config)
      b2 = described_class.get_or_create('svc-a', config: config)
      expect(b1).to be(b2)
    end

    it 'returns different instances for different names' do
      b1 = described_class.get_or_create('svc-a', config: config)
      b2 = described_class.get_or_create('svc-b', config: config)
      expect(b1).not_to be(b2)
    end
  end

  describe '.registry' do
    it 'returns a duplicate hash not affecting internal registry when modified' do
      b1 = described_class.get_or_create('svc-a', config: config)
      reg_copy = described_class.registry
      reg_copy['new'] = :value
      reg_after = described_class.registry
      expect(reg_after).not_to have_key('new')
      expect(reg_after['svc-a']).to be(b1)
    end
  end

  describe '#state' do
    it 'is CLOSED initially' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'transitions to HALF_OPEN after timeout when open' do
      expect do
        expect do
          breaker.execute do
            raise 'fail-1'
          end
        end.to raise_error(RuntimeError, 'fail-1')
        expect do
          breaker.execute do
            raise 'fail-2'
          end
        end.to raise_error(RuntimeError, 'fail-2')
      end.not_to raise_error
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#execute' do
    it 'raises ArgumentError without a block' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError, /Block required/)
    end

    it 'executes the block when closed and records success' do
      result = breaker.execute do
        'ok'
      end
      expect(result).to eq('ok')
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'records failure and raises the original error' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')
      expect(breaker.metrics.failed_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
    end

    it 'opens after reaching failure_threshold' do
      expect do
        expect do
          breaker.execute do
            raise 'fail-1'
          end
        end.to raise_error(RuntimeError, 'fail-1')
        expect do
          breaker.execute do
            raise 'fail-2'
          end
        end.to raise_error(RuntimeError, 'fail-2')
      end.not_to raise_error
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'rejects calls when open and returns fallback if provided' do
      2.times do
        breaker.execute do
          raise 'fail'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      res = breaker.execute(fallback: -> { 'fallback' }) do
        'should not run'
      end
      expect(res).to eq('fallback')
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'raises OpenError when open and no fallback' do
      2.times do
        breaker.execute do
          raise 'fail'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      expect do
        breaker.execute do
          'nope'
        end
      end.to raise_error(CircuitBreaker::OpenError) do |e|
        expect(e.name).to eq(breaker_name)
        expect(e.remaining_time).to be >= 0
      end
    end

    it 'allows limited calls in HALF_OPEN and closes on enough successes' do
      2.times do
        breaker.execute do
          raise 'fail'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      r1 = breaker.execute do
        's1'
      end
      expect(r1).to eq('s1')
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      r2 = breaker.execute do
        's2'
      end
      expect(r2).to eq('s2')
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 're-opens on failure in HALF_OPEN' do
      2.times do
        breaker.execute do
          raise 'fail'
        end
      rescue RuntimeError
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.01)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      expect do
        breaker.execute do
          raise 'half-open-failure'
        end
      end.to raise_error(RuntimeError, 'half-open-failure')
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#health_info' do
    it 'returns a hash with expected keys and uppercase state without deadlock' do
      allow(breaker.metrics).to receive(:average_response_time).and_return(0.111)
      info = breaker.health_info
      expect(info[:name]).to eq(breaker_name)
      expect(info[:state]).to eq('CLOSED')
      expect(info).to have_key(:failure_count)
      expect(info).to have_key(:success_count)
      expect(info).to have_key(:failure_rate)
      expect(info).to have_key(:metrics)
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:config][:success_threshold]).to eq(config.success_threshold)
      expect(info[:config][:timeout_seconds]).to eq(config.timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) do
    'http://coordinator.local'
  end

  let(:sync_interval) do
    0.02
  end

  let(:coordinator) do
    described_class.new(coordinator_url, sync_interval: sync_interval)
  end

  let(:config) do
    CircuitBreaker::Config.new(timeout_seconds: 0.05)
  end

  let(:breaker) do
    CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(3)}", config: config)
  end

  describe '#register' do
    it 'stores the breaker and posts registration to coordinator' do
      http = instance_double(Net::HTTP)
      response = instance_double(Net::HTTPResponse)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      expect do
        coordinator.register(breaker)
      end.not_to raise_error
      expect(Net::HTTP).to have_received(:new)
      expect(http).to have_received(:request)
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'periodically reports state to the coordinator' do
      http = instance_double(Net::HTTP)
      response = instance_double(Net::HTTPResponse)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      coordinator.register(breaker)
      coordinator.start_sync
      sleep(sync_interval * 3)
      coordinator.stop_sync

      expect(http).to have_received(:request).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'fetches and parses cluster aggregate state' do
      body = { 'aggregate' => { 'state' => 'CLOSED' } }.to_json
      resp = instance_double(Net::HTTPResponse, body: body)
      allow(Net::HTTP).to receive(:get_response).and_return(resp)
      result = coordinator.get_cluster_state('my-svc')
      expect(result).to eq('aggregate' => { 'state' => 'CLOSED' })
    end

    it 'returns error hash when request fails' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('boom'))
      res = coordinator.get_cluster_state('my-svc')
      expect(res).to eq({ error: 'boom' })
    end
  end
end
