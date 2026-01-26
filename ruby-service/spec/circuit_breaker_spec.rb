# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmp58pomf7q.rb:206: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
... -> { :fallback }) donot_called
...                   ^~~~~~~~~~~~
# Please review and fix any issues before running

require 'spec_helper'
require 'time'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'returns all valid states in order' do
      expect(described_class.all).to eq([:closed, :open, :half_open])
    end
  end
end

RSpec.describe CircuitBreaker::Config do
  describe '#initialize' do
    it 'assigns default values' do
      config = described_class.new
      expect(config.failure_threshold).to eq(5)
      expect(config.success_threshold).to eq(3)
      expect(config.timeout_seconds).to eq(30.0)
      expect(config.half_open_max_calls).to eq(3)
      expect(config.sliding_window_size).to eq(10)
      expect(config.failure_rate_threshold).to eq(0.5)
    end

    it 'allows overriding defaults' do
      config = described_class.new(
        failure_threshold: 2,
        success_threshold: 4,
        timeout_seconds: 1.5,
        half_open_max_calls: 2,
        sliding_window_size: 8,
        failure_rate_threshold: 0.25
      )
      expect(config.failure_threshold).to eq(2)
      expect(config.success_threshold).to eq(4)
      expect(config.timeout_seconds).to eq(1.5)
      expect(config.half_open_max_calls).to eq(2)
      expect(config.sliding_window_size).to eq(8)
      expect(config.failure_rate_threshold).to eq(0.25)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments success and total calls and sets last_success_time' do
      metrics.record_success(0.1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_success_time).not_to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments failure and total calls and sets last_failure_time' do
      metrics.record_failure(0.2)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.last_failure_time).not_to be_nil
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
    it 'increments state_transitions count' do
      expect(metrics.state_transitions).to eq(0)
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when there are no timings' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns average of recorded durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a hash of metrics without deadlock and with average converted to ms' do
      allow(metrics).to receive(:average_response_time).and_return(0.12345)
      info = metrics.to_h
      expect(info[:total_calls]).to eq(0)
      expect(info[:successful_calls]).to eq(0)
      expect(info[:failed_calls]).to eq(0)
      expect(info[:rejected_calls]).to eq(0)
      expect(info[:state_transitions]).to eq(0)
      expect(info[:average_response_time_ms]).to eq(123.45)
      expect(info[:last_failure_time]).to be_nil
      expect(info[:last_success_time]).to be_nil
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
  let(:name) { 'test-service' }
  let(:breaker) { described_class.new(name, config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('svc', config: config)
      b2 = described_class.get_or_create('svc', config: config)
      expect(b1).to be(b2)
    end

    it 'uses the config from the first creation' do
      cfg1 = CircuitBreaker::Config.new(failure_threshold: 10)
      cfg2 = CircuitBreaker::Config.new(failure_threshold: 1)
      b1 = described_class.get_or_create('svc2', config: cfg1)
      b2 = described_class.get_or_create('svc2', config: cfg2)
      expect(b1.config.failure_threshold).to eq(10)
      expect(b2.config.failure_threshold).to eq(10)
    end
  end

  describe '.registry' do
    it 'returns a duplicate of the internal registry' do
      described_class.get_or_create('svc3', config: config)
      reg = described_class.registry
      expect(reg).to be_a(Hash)
      reg['new'] = :x
      expect(described_class.registry).not_to have_key('new')
    end
  end

  describe '#execute' do
    it 'raises ArgumentError when no block is given' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError)
    end

    it 'executes the block and records success when closed' do
      result = breaker.execute dook
      end
      expect(result).to eq(:ok)
      expect(breaker.metrics.successful_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
    end

    it 'records failure and remains closed until threshold reached' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.metrics.failed_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'opens after reaching failure threshold and rejects subsequent calls' do
      expect do
        breaker.execute do
          raise 'fail1'
        end
      end.to raise_error(RuntimeError)
      expect do
        breaker.execute do
          raise 'fail2'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      expect do
        breaker.execute doshould_not_run
        end
      end.to raise_error(CircuitBreaker::OpenError)
      expect(breaker.metrics.rejected_calls).to eq(1)
    end

    it 'returns fallback result when open and fallback provided' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      result = breaker.execute(fallback: -> { :fallback }) donot_called
      end
      expect(result).to eq(:fallback)
    end

    it 'limits allowed calls in HALF_OPEN' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      allowed_results = []
      config.half_open_max_calls.times do
        allowed_results << breaker.execute dook
        end
      end
      expect(allowed_results).to eq([:ok, :ok])

      res = breaker.execute(fallback: -> { :fb }) donot_called
      end
      expect(res).to eq(:fb)
    end

    it 're-opens on failure in HALF_OPEN' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      expect do
        breaker.execute do
          raise 'half-open failure'
        end
      end.to raise_error(RuntimeError)
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
    end

    it 'closes after enough successes in HALF_OPEN' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

      config.success_threshold.times do
        breaker.execute dook
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'opens when failure rate threshold is met even if failure count below threshold' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 10,
        success_threshold: 2,
        timeout_seconds: 1.0,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.25
      )
      b = described_class.new('rate-service', config: cfg)
      expect do
        b.execute do
          raise 'f'
        end
      end.to raise_error(RuntimeError)
      expect(b.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#state' do
    it 'returns current state and transitions to HALF_OPEN after timeout' do
      2.times do
        begin
          breaker.execute do
            raise 'f'
          end
        rescue RuntimeError
        end
      end
      expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      sleep(config.timeout_seconds + 0.02)
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#health_info' do
    it 'returns health info hash with uppercase state and config' do
      allow(breaker.metrics).to receive(:to_h).and_return({ total_calls: 0 })
      info = breaker.health_info
      expect(info[:name]).to eq(name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:metrics]).to eq({ total_calls: 0 })
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
  let(:sync_interval) { 0.02 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }
  let(:config) { CircuitBreaker::Config.new(failure_threshold: 1, timeout_seconds: 0.01) }
  let(:breaker) { CircuitBreaker::Breaker.new('service-a', config: config) }

  def stub_http_new_with_post_capture(expected_path)
    uri = URI("#{coordinator_url}#{expected_path}")
    http = instance_double(Net::HTTP)
    response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
    allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request) do |req|
      expect(req).to be_a(Net::HTTP::Post)
      expect(req['Content-Type']).to eq('application/json')
      response
    end
    http
  end

  describe '#register' do
    it 'sends registration to coordinator' do
      http = stub_http_new_with_post_capture('/circuit-breakers/register')
      expect(http).to receive(:request).at_least(:once)
      coordinator.register(breaker)
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'starts a background thread that calls synchronize_states periodically' do
      allow(coordinator).to receive(:synchronize_states)
      coordinator.start_sync
      sleep(sync_interval * 3)
      coordinator.stop_sync
      expect(coordinator).to have_received(:synchronize_states).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON on success' do
      uri = URI("#{coordinator_url}/circuit-breakers/service-x/aggregate")
      resp = instance_double(Net::HTTPResponse, body: '{"state":"CLOSED"}')
      allow(Net::HTTP).to receive(:get_response).with(uri).and_return(resp)
      result = coordinator.get_cluster_state('service-x')
      expect(result).to eq({ 'state' => 'CLOSED' })
    end

    it 'returns error hash on failure' do
      uri = URI("#{coordinator_url}/circuit-breakers/service-y/aggregate")
      allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('boom'))
      result = coordinator.get_cluster_state('service-y')
      expect(result).to eq({ error: 'boom' })
    end
  end

  describe 'periodic state reporting' do
    it 'posts breaker state to coordinator during sync' do
      http = stub_http_new_with_post_capture('/circuit-breakers/state')
      allow(coordinator).to receive(:report_state).and_call_original
      allow(breaker).to receive(:health_info).and_return({ status: 'ok' })

      coordinator.register(breaker)
      coordinator.start_sync
      sleep(sync_interval * 3)
      coordinator.stop_sync

      expect(coordinator).to have_received(:report_state).at_least(:once)
      expect(http).to have_received(:request).at_least(:once)
    end
  end
end
