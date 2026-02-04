require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker::State do
  describe '.all' do
    it 'includes CLOSED, OPEN, and HALF_OPEN' do
      expect(described_class.all).to match_array([
                                                   CircuitBreaker::State::CLOSED,
                                                   CircuitBreaker::State::OPEN,
                                                   CircuitBreaker::State::HALF_OPEN
                                                 ])
    end
  end
end

RSpec.describe CircuitBreaker::OpenError do
  describe '#initialize' do
    it 'sets name, remaining_time, and formats message' do
      err = described_class.new('service-a', 1.236)
      expect(err.name).to eq('service-a')
      expect(err.remaining_time).to be_within(0.01).of(1.236)
      expect(err.message).to include("Circuit breaker 'service-a' is open. Retry after")
      expect(err.message).to include('1.24')
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

    it 'allows overriding values' do
      cfg = described_class.new(
        failure_threshold: 2,
        success_threshold: 4,
        timeout_seconds: 1.2,
        half_open_max_calls: 5,
        sliding_window_size: 6,
        failure_rate_threshold: 0.7
      )
      expect(cfg.failure_threshold).to eq(2)
      expect(cfg.success_threshold).to eq(4)
      expect(cfg.timeout_seconds).to eq(1.2)
      expect(cfg.half_open_max_calls).to eq(5)
      expect(cfg.sliding_window_size).to eq(6)
      expect(cfg.failure_rate_threshold).to eq(0.7)
    end
  end
end

RSpec.describe CircuitBreaker::Metrics do
  let(:metrics) do
    described_class.new
  end

  describe '#record_success' do
    it 'increments counts and sets last_success_time' do
      t_before = Time.now
      metrics.record_success(0.05)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.successful_calls).to eq(1)
      expect(metrics.failed_calls).to eq(0)
      expect(metrics.last_success_time).not_to be_nil
      expect(metrics.last_success_time).to be >= t_before
    end
  end

  describe '#record_failure' do
    it 'increments counts and sets last_failure_time' do
      t_before = Time.now
      metrics.record_failure(0.02)
      expect(metrics.total_calls).to eq(1)
      expect(metrics.failed_calls).to eq(1)
      expect(metrics.successful_calls).to eq(0)
      expect(metrics.last_failure_time).not_to be_nil
      expect(metrics.last_failure_time).to be >= t_before
    end
  end

  describe '#record_rejection' do
    it 'increments rejected_calls' do
      expect do
        metrics.record_rejection
      end.not_to raise_error
      expect(metrics.rejected_calls).to eq(1)
    end
  end

  describe '#record_state_transition' do
    it 'increments state_transitions' do
      expect do
        metrics.record_state_transition
      end.not_to raise_error
      expect(metrics.state_transitions).to eq(1)
    end
  end

  describe '#average_response_time' do
    it 'returns 0 when no samples' do
      expect(metrics.average_response_time).to eq(0)
    end

    it 'computes average over samples' do
      metrics.record_success(0.1)
      metrics.record_failure(0.3)
      expect(metrics.average_response_time).to be_within(0.0001).of(0.2)
    end
  end

  describe '#to_h' do
    it 'returns a hash with computed fields without deadlock' do
      allow(metrics).to receive(:average_response_time).and_return(0.1234)
      h = metrics.to_h
      expect(h).to be_a(Hash)
      expect(h[:total_calls]).to eq(0)
      expect(h[:average_response_time_ms]).to eq((0.1234 * 1000).round(2))
    end
  end
end

RSpec.describe CircuitBreaker::Breaker do
  let(:name) { "svc-#{SecureRandom.hex(4)}" }
  let(:config) do
    CircuitBreaker::Config.new(
      failure_threshold: 3,
      success_threshold: 2,
      timeout_seconds: 0.05,
      half_open_max_calls: 3,
      sliding_window_size: 10,
      failure_rate_threshold: 0.9
    )
  end
  let(:breaker) { described_class.new(name, config: config) }

  describe '.get_or_create' do
    it 'returns the same instance for the same name' do
      b1 = described_class.get_or_create(name, config: config)
      b2 = described_class.get_or_create(name, config: CircuitBreaker::Config.new)
      expect(b1).to be(b2)
    end
  end

  describe '.registry' do
    it 'returns a copy of the registry' do
      b = described_class.get_or_create(name, config: config)
      reg = described_class.registry
      expect(reg[name]).to be(b)
      reg['other'] = :x
      reg2 = described_class.registry
      expect(reg2).not_to have_key('other')
    end
  end

  describe '#execute' do
    it 'requires a block' do
      expect do
        breaker.execute
      end.to raise_error(ArgumentError, /Block required/)
    end

    it 'executes the block and returns result when closed' do
      result = breaker.execute do
        ok
      end
      expect(result).to eq(:ok)
      expect(breaker.send(:state)).to eq(CircuitBreaker::State::CLOSED)
      expect(breaker.metrics.total_calls).to eq(1)
      expect(breaker.metrics.successful_calls).to eq(1)
    end

    it 'records failure and re-raises error' do
      expect do
        breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError, 'boom')
      expect(breaker.metrics.failed_calls).to eq(1)
      expect(breaker.metrics.total_calls).to eq(1)
    end

    it 'opens after reaching failure threshold' do
      3.times do
        expect do
          breaker.execute do
            raise 'x'
          end
        end.to raise_error(RuntimeError)
      end
      expect(breaker.send(:state)).to eq(CircuitBreaker::State::OPEN)
    end

    it 'returns fallback when open and fallback provided' do
      # Open the breaker quickly
      fast_cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 1,
        timeout_seconds: 5.0,
        half_open_max_calls: 1,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
      fast_breaker = described_class.new("#{name}-fb", config: fast_cfg)
      expect do
        fast_breaker.execute do
          raise 'fail'
        end
      end.to raise_error(RuntimeError)
      # Now open
      executed = false
      res = fast_breaker.execute(fallback: -> { :fallback }) do
        executed = true
        :should_not_run
      end
      expect(res).to eq(:fallback)
      expect(executed).to eq(false)
      expect(fast_breaker.metrics.rejected_calls).to eq(1)
    end

    it 'raises OpenError when open and no fallback' do
      fast_cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 1,
        timeout_seconds: 0.2,
        half_open_max_calls: 1,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
      fast_breaker = described_class.new("#{name}-oe", config: fast_cfg)
      expect do
        fast_breaker.execute do
          raise 'boom'
        end
      end.to raise_error(RuntimeError)
      expect do
        fast_breaker.execute do
          wontrun
        end
      end.to raise_error(CircuitBreaker::OpenError) do |e|
        expect(e.name).to eq("#{name}-oe")
        expect(e.remaining_time).to be > 0
        expect(e.remaining_time).to be <= 0.2
      end
    end
  end

  describe '#state transitions' do
    it 'moves from OPEN to HALF_OPEN after timeout' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 2,
        timeout_seconds: 0.03,
        half_open_max_calls: 3,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
      br = described_class.new("#{name}-timeout", config: cfg)
      expect do
        br.execute do
          raise 'fail'
        end
      end.to raise_error(RuntimeError)
      expect(br.state).to eq(CircuitBreaker::State::OPEN)
      sleep 0.05
      expect(br.state).to eq(CircuitBreaker::State::HALF_OPEN)
    end

    it 'limits calls in HALF_OPEN and uses fallback when limit reached' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 3,
        timeout_seconds: 0.02,
        half_open_max_calls: 2,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
      br = described_class.new("#{name}-half", config: cfg)
      expect do
        br.execute do
          raise 'fail'
        end
      end.to raise_error(RuntimeError)
      sleep 0.03
      expect(br.state).to eq(CircuitBreaker::State::HALF_OPEN)

      executed = 0
      r1 = br.execute do
        executed += 1
        :ok1
      end
      r2 = br.execute do
        executed += 1
        :ok2
      end
      r3 = br.execute(fallback: -> { :fb }) do
        executed += 1
        :ok3
      end

      expect(r1).to eq(:ok1)
      expect(r2).to eq(:ok2)
      expect(r3).to eq(:fb)
      expect(executed).to eq(2)
    end

    it 'closes after enough successes in HALF_OPEN' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 2,
        timeout_seconds: 0.02,
        half_open_max_calls: 3,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
      br = described_class.new("#{name}-close", config: cfg)
      expect do
        br.execute do
          raise 'fail'
        end
      end.to raise_error(RuntimeError)
      sleep 0.03
      expect(br.state).to eq(CircuitBreaker::State::HALF_OPEN)
      br.execute do
        ok
      end
      br.execute do
        ok
      end
      expect(br.state).to eq(CircuitBreaker::State::CLOSED)
      res = br.execute do
        after_closed
      end
      expect(res).to eq(:after_closed)
    end

    it 're-opens on failure in HALF_OPEN' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 1,
        success_threshold: 2,
        timeout_seconds: 0.02,
        half_open_max_calls: 3,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
      br = described_class.new("#{name}-reopen", config: cfg)
      expect do
        br.execute do
          raise 'fail'
        end
      end.to raise_error(RuntimeError)
      sleep 0.03
      expect(br.state).to eq(CircuitBreaker::State::HALF_OPEN)
      expect do
        br.execute do
          raise 'again'
        end
      end.to raise_error(RuntimeError)
      expect(br.state).to eq(CircuitBreaker::State::OPEN)
    end
  end

  describe '#health_info' do
    it 'returns structured information including state and config' do
      allow(breaker.metrics).to receive(:to_h).and_return(
        {
          total_calls: 0,
          successful_calls: 0,
          failed_calls: 0,
          rejected_calls: 0,
          state_transitions: 0,
          average_response_time_ms: 0.0,
          last_failure_time: nil,
          last_success_time: nil
        }
      )
      info = breaker.health_info
      expect(info[:name]).to eq(name)
      expect(info[:state]).to eq('CLOSED')
      expect(info[:config][:failure_threshold]).to eq(config.failure_threshold)
      expect(info[:metrics][:average_response_time_ms]).to eq(0.0)
    end

    it 'includes correct failure_rate based on sliding window' do
      cfg = CircuitBreaker::Config.new(
        failure_threshold: 100,
        success_threshold: 1,
        timeout_seconds: 1.0,
        half_open_max_calls: 1,
        sliding_window_size: 10,
        failure_rate_threshold: 1.0
      )
      br = described_class.new("#{name}-rate", config: cfg)
      allow(br.metrics).to receive(:to_h).and_return({})
      3.times do
        expect do
          br.execute do
            raise 'x'
          end
        end.to raise_error(RuntimeError)
      end
      hi = br.health_info
      expect(hi[:failure_count]).to eq(3)
      expect(hi[:failure_rate]).to be_within(0.0001).of(0.3)
    end
  end
end

RSpec.describe CircuitBreaker::DistributedCoordinator do
  let(:coordinator_url) { 'http://coordinator.local' }
  let(:coordinator) { described_class.new(coordinator_url, sync_interval: 0.02) }
  let(:breaker) do
    CircuitBreaker::Breaker.new("svc-#{SecureRandom.hex(4)}", config: CircuitBreaker::Config.new)
  end

  describe '#register' do
    it 'sends registration via HTTP' do
      uri = URI("#{coordinator_url}/circuit-breakers/register")
      http = instance_double(Net::HTTP)
      response = instance_double(Net::HTTPResponse)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      expect do
        coordinator.register(breaker)
      end.not_to raise_error

      expect(Net::HTTP).to have_received(:new).with(uri.host, uri.port)
      expect(http).to have_received(:open_timeout=).with(5)
      expect(http).to have_received(:read_timeout=).with(5)
      expect(http).to have_received(:request).at_least(:once)
    end
  end

  describe '#get_cluster_state' do
    it 'returns parsed JSON response' do
      uri = URI("#{coordinator_url}/circuit-breakers/#{breaker.name}/aggregate")
      resp = instance_double(Net::HTTPResponse, body: { foo: 'bar' }.to_json)
      allow(Net::HTTP).to receive(:get_response).with(uri).and_return(resp)

      data = coordinator.get_cluster_state(breaker.name)
      expect(data).to eq('foo' => 'bar')
    end

    it 'returns error hash on exception' do
      uri = URI("#{coordinator_url}/circuit-breakers/#{breaker.name}/aggregate")
      allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('boom'))
      data = coordinator.get_cluster_state(breaker.name)
      expect(data[:error]).to eq('boom')
    end
  end

  describe '#start_sync and #stop_sync' do
    it 'periodically reports state while running' do
      allow(coordinator).to receive(:report_state).and_return(nil)
      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.06
      coordinator.stop_sync
      expect(coordinator).to have_received(:report_state).at_least(:once)
    end

    it 'uses HTTP in report_state when not stubbed' do
      uri = URI("#{coordinator_url}/circuit-breakers/state")
      http = instance_double(Net::HTTP)
      response = instance_double(Net::HTTPResponse)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)

      coordinator.register(breaker)
      coordinator.start_sync
      sleep 0.05
      coordinator.stop_sync

      expect(Net::HTTP).to have_received(:new).with(uri.host, uri.port).at_least(:once)
      expect(http).to have_received(:open_timeout=).with(5).at_least(:once)
      expect(http).to have_received(:read_timeout=).with(5).at_least(:once)
      expect(http).to have_received(:request).at_least(:once)
    end
  end
end
