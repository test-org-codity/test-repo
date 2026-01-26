require 'spec_helper'
require 'json'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name and remaining_time and message' do
      error = described_class.new('service_a', 2.5)
      expect(error.name).to eq('service_a')
      expect(error.remaining_time).to eq(2.5)
      expect(error.message).to include("Circuit breaker 'service_a' is open")
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
    it 'has sensible defaults' do
      c = described_class.new
      expect(c.failure_threshold).to eq(5)
      expect(c.success_threshold).to eq(3)
      expect(c.timeout_seconds).to eq(30.0)
      expect(c.half_open_max_calls).to eq(3)
      expect(c.sliding_window_size).to eq(10)
      expect(c.failure_rate_threshold).to eq(0.5)
    end

    it 'allows overriding values' do
      c = described_class.new(
        failure_threshold: 2,
        success_threshold: 1,
        timeout_seconds: 0.5,
        half_open_max_calls: 1,
        sliding_window_size: 4,
        failure_rate_threshold: 0.25
      )
      expect(c.failure_threshold).to eq(2)
      expect(c.success_threshold).to eq(1)
      expect(c.timeout_seconds).to eq(0.5)
      expect(c.half_open_max_calls).to eq(1)
      expect(c.sliding_window_size).to eq(4)
      expect(c.failure_rate_threshold).to eq(0.25)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) do
    described_class.new
  end

  describe '#record_success' do
    it 'increments totals and success counts and sets last_success_time' do
      metrics.record_success(0.1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.last_success_time).not_to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments totals and failure counts and sets last_failure_time' do
      metrics.record_failure(0.2)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.last_failure_time).not_to be_nil
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
    it 'returns 0 when no data' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns the average when there is data' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      avg = metrics.average_response_time
      expect(avg).to be > 0
      expect(avg).to be_within(0.001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a hash of metrics without deadlock' do
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      result = metrics.to_h
      expect(result).to include(:total_calls, :successful_calls, :failed_calls, :rejected_calls, :state_transitions,
                                :average_response_time_ms, :last_failure_time, :last_success_time)
      expect(result[:average_response_time_ms]).to eq(123.0)
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

  let(:breaker) do
    described_class.new('service_a', config: config)
  end

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      a = described_class.get_or_create('svc1', config: config)
      b = described_class.get_or_create('svc1', config: config)
      expect(a).to equal(b)
    end

    it 'returns different instances for different names' do
      a = described_class.get_or_create('svc2', config: config)
      b = described_class.get_or_create('svc3', config: config)
      expect(a).not_to equal(b)
    end
  end

  describe '.registry' do
    it 'returns a duplicate hash of registry' do
      CircuitBreaker::Breaker.get_or_create('reg_svc', config: config)
      reg = CircuitBreaker::Breaker.registry
      expect(reg).to be_a(Hash)
      expect(reg['reg_svc']).to be_a(CircuitBreaker::Breaker)
    end
  end

  describe '#state' do
    it 'starts in CLOSED state' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end
  end

  describe '#execute' do
    it 'requires a block' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'executes the block and returns the result on success' do
      result = breaker.execute do
        ok
      end
      expect(result).to eq(:ok)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.metrics.failed_calls).to eq(0)
    end

    it 'records failure and raises the original error' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')
      expect(breaker.metrics.failed_calls).to eq(1)
    end

    it 'opens the circuit after reaching failure threshold' do
      2.times do
        expect do
          breaker.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError, 'fail')
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'rejects calls when open and raises OpenError' do
      2.times do
        expect do
          breaker.execute do
            raise 'err'
          end
        end.to raise_error(RuntimeError)
      end
      expect do
        breaker.execute do
          should_not_run
        end
      end.to raise_error(CircuitBreaker::OpenError)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'uses fallback when provided in open state' do
      2.times do
        expect do
          breaker.execute do
            raise 'err2'
          end
        end.to raise_error(RuntimeError)
      end
      result = breaker.execute(fallback: -> { :fallback }) do
        not_run
      end
      expect(result).to eq(:fallback)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'transitions to HALF_OPEN after timeout and limits calls' do
      2.times do
        expect do
          breaker.execute do
            raise 'err3'
          end
        end.to raise_error(RuntimeError)
      end
      opened_time = Time.now
      allow(Time).to receive(:now).and_return(opened_time)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      allow(Time).to receive(:now).and_return(opened_time + 0.11)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      call1 = breaker.execute do
        ok1
      end
      call2 = breaker.execute do
        ok2
      end
      expect(call1).to eq(:ok1)
      expect(call2).to eq(:ok2)
      expect do
        breaker.execute do
          ok3
        end
      end.to raise_error(CircuitBreaker::OpenError)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'in HALF_OPEN transitions to CLOSED after enough successes' do
      2.times do
        expect do
          breaker.execute do
            raise 'err4'
          end
        end.to raise_error(RuntimeError)
      end
      t0 = Time.now
      allow(Time).to receive(:now).and_return(t0, t0 + 0.11, t0 + 0.12, t0 + 0.13, t0 + 0.14)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      breaker.execute do
        ok
      end
      breaker.execute do
        ok
      end

      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'in HALF_OPEN transitions back to OPEN on failure' do
      2.times do
        expect do
          breaker.execute do
            raise 'err5'
          end
        end.to raise_error(RuntimeError)
      end
      t0 = Time.now
      allow(Time).to receive(:now).and_return(t0, t0 + 0.11, t0 + 0.12)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      expect do
        breaker.execute do
          raise 'half-open failure'
        end
      end.to raise_error(RuntimeError, 'half-open failure')

      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'opens due to failure_rate_threshold via sliding window' do
      breaker.execute do
        ok
      end
      expect do
        breaker.execute do
          raise 'x1'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'x2'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#health_info' do
    it 'returns a structured hash with configuration and metrics' do
      allow(breaker.metrics).to receive(:average_response_time).and_return(0.0)
      info = breaker.health_info
      expect(info[:name]).to eq('service_a')
      expect(info[:state]).to be_a(String)
      expect(info[:config]).to include(:failure_threshold, :success_threshold, :timeout_seconds)
      expect(info[:metrics]).to include(:total_calls, :successful_calls, :failed_calls, :rejected_calls)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:url) do
    'http://coordinator.test'
  end

  let(:coordinator) do
    described_class.new(url, sync_interval: 0.01)
  end

  let(:breaker) do
    CircuitBreaker::Breaker.new('svc', config: CircuitBreaker::Config.new)
  end

  describe '#register' do
    it 'sends a registration HTTP request and do
      es not raise on success' do
      uri = URI("#{url}/circuit-breakers/register")
      http = instance_double(Net::HTTP)
      response = instance_double(Net::HTTPResponse)

      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end

    it 'rescues errors from HTTP registration' do
      uri = URI("#{url}/circuit-breakers/register")
      http = instance_double(Net::HTTP)

      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(StandardError.new('netfail'))

      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background thread that reports state periodically' do
      http = instance_double(Net::HTTP)
      response = instance_double(Net::HTTPResponse)

      allow(breaker).to receive(:state).and_return(CircuitBreaker::State::CLOSED)
      allow(breaker).to receive(:health_info).and_return({})

      uri = URI("#{url}/circuit-breakers/state")
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.03
      coordinator.stop_sync

      expect(http).to have_received(:request).at_least(:once)
    end

    it 'handles HTTP errors during sync without raising' do
      http = instance_double(Net::HTTP)

      allow(breaker).to receive(:state).and_return(CircuitBreaker::State::CLOSED)
      allow(breaker).to receive(:health_info).and_return({})

      uri = URI("#{url}/circuit-breakers/state")
      allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(StandardError.new('syncfail'))

      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.03
      expect do
        coordinator.stop_sync
      end.not_to raise_error
    end
  end

  describe '#get_cluster_state' do
    it 'fetches and parses aggregate state' do
      body = { 'status' => 'ok', 'count' => 1 }.to_json
      response = instance_double(Net::HTTPResponse, body: body)
      allow(Net::HTTP).to receive(:get_response).and_return(response)
      result = coordinator.get_cluster_state('svc')
      expect(result).to eq(JSON.parse(body))
    end

    it 'returns error hash when request fails' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('getfail'))
      result = coordinator.get_cluster_state('svc')
      expect(result).to include(:error)
      expect(result[:error]).to include('getfail')
    end
  end
end
