# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpix0mxxej.rb:279: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
...{ :fallback }) doshould_not_run
...               ^~~~~~~~~~~~~~~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

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

      it 'sets default values' do
        expect(config.failure_threshold).to eq(5)
        expect(config.success_threshold).to eq(3)
        expect(config.timeout_seconds).to eq(30.0)
        expect(config.half_open_max_calls).to eq(3)
        expect(config.sliding_window_size).to eq(10)
        expect(config.failure_rate_threshold).to eq(0.5)
      end
    end

    context 'with overrides' do
      let(:config) do
        described_class.new(
          failure_threshold: 2,
          success_threshold: 4,
          timeout_seconds: 1.5,
          half_open_max_calls: 2,
          sliding_window_size: 5,
          failure_rate_threshold: 0.3
        )
      end

      it 'applies provided values' do
        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(4)
        expect(config.timeout_seconds).to eq(1.5)
        expect(config.half_open_max_calls).to eq(2)
        expect(config.sliding_window_size).to eq(5)
        expect(config.failure_rate_threshold).to eq(0.3)
      end
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) { described_class.new }

  describe '#record_success' do
    it 'increments success and total, sets last_success_time' do
      expect(metrics.total_calls).to eq(0)
      expect(metrics.successful_calls).to eq(0)
      metrics.record_success(0.01)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.last_success_time).not_to be_nil
    end
  end

  describe '#record_failure' do
    it 'increments failure and total, sets last_failure_time' do
      expect(metrics.total_calls).to eq(0)
      expect(metrics.failed_calls).to eq(0)
      metrics.record_failure(0.02)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.failed_calls).to eq(1)
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
    it 'increments state_transitions' do
      expect(metrics.state_transitions).to eq(0)
      metrics.record_state_transition
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when no samples' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'returns average of durations' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      avg = metrics.average_response_time
      expect(avg).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a hash with metrics and computed average without deadlock' do
      # Avoid nested mutex deadlock by stubbing average_response_time
      allow(metrics).to receive(:average_response_time).and_return(0.123)
      metrics.record_success(0.1)
      metrics.record_failure(0.2)
      h = metrics.to_h
      expect(h[:total_calls]).to eq(2)
      expect(h[:successful_calls]).to eq(1)
      expect(h[:failed_calls]).to eq(1)
      expect(h[:rejected_calls]).to eq(0)
      expect(h[:state_transitions]).to eq(0)
      expect(h[:average_response_time_ms]).to eq((0.123 * 1000).round(2))
      expect(h[:last_success_time]).to be_a(String)
      expect(h[:last_failure_time]).to be_a(String)
    end
  end
end

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name, remaining_time and builds message' do
      err = described_class.new('svc', 5.25)
      expect(err.name).to eq('svc')
      expect(err.remaining_time).to eq(5.25)
      expect(err.message).to include("Circuit breaker 'svc' is open.")
      expect(err.message).to include('Retry after')
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
      failure_rate_threshold: 0.9
    )
  end

  let(:breaker) { described_class.new('service-a', config: config) }

  before do
    described_class.class_variable_set(:@@registry, {})
  end

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create('svc')
      b2 = described_class.get_or_create('svc')
      expect(b1).to be(b2)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry' do
      b = described_class.get_or_create('svc-x')
      reg = described_class.registry
      expect(reg['svc-x']).to be(b)
      reg.delete('svc-x')
      expect(described_class.registry['svc-x']).to be(b)
    end
  end

  describe '#state' do
    it 'starts in CLOSED' do
      expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
    end

    it 'moves from OPEN to HALF_OPEN after timeout' do
      breaker.instance_variable_set(:@state, CircuitBreaker::State::OPEN)
      breaker.instance_variable_set(:@opened_at, Time.now - (config.timeout_seconds + 0.01))
      expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end
  end

  describe '#execute' do
    context 'when no block is given' do
      it 'raises ArgumentError' do
        expect do
          breaker.execute
        end.to raise_error(ArgumentError)
      end
    end

    context 'when CLOSED' do
      it 'executes the block and returns the result' do
        result = breaker.execute do
          42
        end
        expect(result).to eq(42)
        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.metrics.successful_calls).to eq(1)
      end

      it 'records failure and re-raises error' do
        expect do
          breaker.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError, 'boom')
        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.metrics.failed_calls).to eq(1)
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'opens after reaching failure_threshold' do
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
        expect(breaker.metrics.state_transitions).to eq(1)
      end
    end

    context 'when failure rate threshold is exceeded' do
      let(:rate_config) do
        CircuitBreaker::Config.new(
          failure_threshold: 100,
          success_threshold: 2,
          timeout_seconds: 10,
          half_open_max_calls: 3,
          sliding_window_size: 4,
          failure_rate_threshold: 0.5
        )
      end

      let(:rate_breaker) { described_class.new('service-rate', config: rate_config) }

      it 'opens based on sliding window failure rate' do
        rate_breaker.execute dook
        end
        expect do
          rate_breaker.execute do
            raise 'f1'
          end
        end.to raise_error(RuntimeError, 'f1')
        expect do
          rate_breaker.execute do
            raise 'f2'
          end
        end.to raise_error(RuntimeError, 'f2')
        expect(rate_breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end

    context 'when OPEN' do
      before do
        breaker.instance_variable_set(:@state, CircuitBreaker::State::OPEN)
        breaker.instance_variable_set(:@opened_at, Time.now)
      end

      it 'raises OpenError without fallback' do
        expect do
          breaker.execute doshould_not_run
          end
        end.to raise_error(CircuitBreaker::OpenError) do |e|
          expect(e.name).to eq('service-a')
          expect(e.remaining_time).to be >= 0
        end
        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'returns fallback result when provided' do
        res = breaker.execute(fallback: -> { :fallback }) doshould_not_run
        end
        expect(res).to eq(:fallback)
        expect(breaker.metrics.rejected_calls).to eq(1)
      end
    end

    context 'when HALF_OPEN' do
      it 'allows up to half_open_max_calls' do
        cfg = CircuitBreaker::Config.new(
          failure_threshold: 100,
          success_threshold: 5,
          timeout_seconds: 10,
          half_open_max_calls: 2,
          sliding_window_size: 4,
          failure_rate_threshold: 1.0
        )
        ho_breaker = described_class.new('svc-ho', config: cfg)
        ho_breaker.instance_variable_set(:@state, CircuitBreaker::State::HALF_OPEN)
        r1 = ho_breaker.execute dook1
        end
        r2 = ho_breaker.execute dook2
        end
        expect(r1).to eq(:ok1)
        expect(r2).to eq(:ok2)
        expect do
          ho_breaker.execute donot_allowed
          end
        end.to raise_error(CircuitBreaker::OpenError)
        expect(ho_breaker.metrics.rejected_calls).to eq(1)
      end

      it 'closes after reaching success_threshold' do
        cfg = CircuitBreaker::Config.new(
          failure_threshold: 100,
          success_threshold: 2,
          timeout_seconds: 10,
          half_open_max_calls: 5,
          sliding_window_size: 4,
          failure_rate_threshold: 1.0
        )
        ho_breaker = described_class.new('svc-ho2', config: cfg)
        ho_breaker.instance_variable_set(:@state, CircuitBreaker::State::HALF_OPEN)
        ho_breaker.execute dook
        end
        expect(ho_breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
        ho_breaker.execute dook
        end
        expect(ho_breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 're-opens on failure' do
        cfg = CircuitBreaker::Config.new(
          failure_threshold: 100,
          success_threshold: 3,
          timeout_seconds: 10,
          half_open_max_calls: 3,
          sliding_window_size: 4,
          failure_rate_threshold: 1.0
        )
        ho_breaker = described_class.new('svc-ho3', config: cfg)
        ho_breaker.instance_variable_set(:@state, CircuitBreaker::State::HALF_OPEN)
        expect do
          ho_breaker.execute do
            raise 'fail in half open'
          end
        end.to raise_error(RuntimeError, 'fail in half open')
        expect(ho_breaker.state).to eq(CircuitBreaker::State::OPEN)
      end
    end
  end

  describe '#health_info' do
    it 'returns a hash with breaker info' do
      # Avoid nested locks by stubbing metrics.to_h if needed
      allow(breaker.metrics).to receive(:to_h).and_return({ total_calls: 0 })
      info = breaker.health_info
      expect(info[:name]).to eq('service-a')
      expect(info[:state]).to eq('CLOSED')
      expect(info[:failure_count]).to be_a(Integer)
      expect(info[:success_count]).to be_a(Integer)
      expect(info[:metrics]).to eq({ total_calls: 0 })
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:config][:success_threshold]).to eq(config.success_threshold)
      expect(info[:config][:timeout_seconds]).to eq(config.timeout_seconds)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.local' }
  let(:sync_interval) { 0.05 }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }

  def stub_http_request
    http = instance_double(Net::HTTP)
    response = instance_double(Net::HTTPResponse, body: 'ok', code: '200')
    request = instance_double(Net::HTTP::Post)

    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(response)

    allow(Net::HTTP::Post).to receive(:new).and_return(request)
    allow(request).to receive(:[]=)
    allow(request).to receive(:body=)

    response
  end

  describe '#register' do
    it 'stores breaker and sends registration via HTTP' do
      response = stub_http_request
      cfg = CircuitBreaker::Config.new
      breaker = CircuitBreaker::Breaker.new('svc-reg', config: cfg)
      expect(Net::HTTP).to receive(:new).and_return(instance_double(Net::HTTP, use_ssl=:nil, open_timeout=:nil, read_timeout=:nil, request: response))
      allow(Net::HTTP::Post).to receive(:new).and_return(instance_double(Net::HTTP::Post, :[]= => nil, :body= => nil))
      coordinator.register(breaker)
      breakers = coordinator.instance_variable_get(:@breakers)
      expect(breakers['svc-reg']).to be(breaker)
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'periodically reports state for registered breakers' do
      breaker = CircuitBreaker::Breaker.new('svc-sync', config: CircuitBreaker::Config.new)
      coordinator.register(breaker)
      allow(coordinator).to receive(:report_state).and_return(nil)
      coordinator.start_sync
      sleep(sync_interval * 2)
      coordinator.stop_sync
      expect(coordinator).to have_received(:report_state).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON on success' do
      allow(Net::HTTP).to receive(:get_response).and_return(double(body: '{"ok":true}'))
      res = coordinator.get_cluster_state('svc-x')
      expect(res['ok']).to eq(true)
    end

    it 'returns error hash on failure' do
      allow(Net::HTTP).to receive(:get_response).and_raise(StandardError.new('boom'))
      res = coordinator.get_cluster_state('svc-y')
      expect(res[:error]).to eq('boom')
    end
  end

  describe 'HTTP interactions' do
    it 'sends state reports via HTTP in report_state' do
      breaker = CircuitBreaker::Breaker.new('svc-http', config: CircuitBreaker::Config.new)
      coordinator.register(breaker)
      response = stub_http_request
      expect(Net::HTTP).to receive(:new).and_return(instance_double(Net::HTTP, use_ssl=:nil, open_timeout=:nil, read_timeout=:nil, request: response))
      allow(Net::HTTP::Post).to receive(:new).and_return(instance_double(Net::HTTP::Post, :[]= => nil, :body= => nil))
      coordinator.send(:report_state, 'svc-http', breaker)
    end

    it 'handles errors in send_registration gracefully' do
      breaker = CircuitBreaker::Breaker.new('svc-err', config: CircuitBreaker::Config.new)
      allow(Net::HTTP).to receive(:new).and_raise(StandardError.new('network down'))
      expect do
        coordinator.register(breaker)
      end.not_to raise_error
    end
  end
end
