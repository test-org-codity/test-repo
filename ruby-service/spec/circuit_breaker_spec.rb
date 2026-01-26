# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpss20slc1.rb:370: syntax error, unexpected `end' (SyntaxError)
      end
      ^~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker do
  describe CircuitBreaker::OpenError do
    describe '#initialize' do
      it 'exposes name and remaining_time and formats message' do
        err = described_class.new('svc-a', 1.23456)
        expect(err.name).to eq('svc-a')
        expect(err.remaining_time).to eq(1.23456)
        expect(err.message).to include("Circuit breaker 'svc-a' is open")
        expect(err.message).to include('Retry after 1.23s')
      end
    end
  end

  describe CircuitBreaker::State do
    describe '.all' do
      it 'returns all supported states' do
        expect(described_class.all).to contain_exactly(:closed, :open, :half_open)
      end
    end
  end

  describe CircuitBreaker::Config do
    describe '#initialize' do
      it 'uses defaults when not provided' do
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
          success_threshold: 1,
          timeout_seconds: 0.25,
          half_open_max_calls: 1,
          sliding_window_size: 4,
          failure_rate_threshold: 0.75
        )

        expect(cfg.failure_threshold).to eq(2)
        expect(cfg.success_threshold).to eq(1)
        expect(cfg.timeout_seconds).to eq(0.25)
        expect(cfg.half_open_max_calls).to eq(1)
        expect(cfg.sliding_window_size).to eq(4)
        expect(cfg.failure_rate_threshold).to eq(0.75)
      end
    end
  end

  describe CircuitBreaker::Metrics do
    let(:metrics) { described_class.new }

    describe '#record_success' do
      it 'increments counts, sets last_success_time, and tracks response time' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        metrics.record_success(0.1)

        expect(metrics.total_calls).to eq(1)
        expect(metrics.successful_calls).to eq(1)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.last_success_time).to eq(now)
        expect(metrics.average_response_time).to eq(0.1)
      end

      it 'keeps only the latest 100 response times' do
        101.times do
          metrics.record_success(1.0)
        end

        expect(metrics.total_calls).to eq(101)
        expect(metrics.successful_calls).to eq(101)
        expect(metrics.average_response_time).to eq(1.0)
      end
    end

    describe '#record_failure' do
      it 'increments counts, sets last_failure_time, and tracks response time' do
        now = Time.utc(2020, 1, 1, 0, 0, 1)
        allow(Time).to receive(:now).and_return(now)

        metrics.record_failure(0.2)

        expect(metrics.total_calls).to eq(1)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.failed_calls).to eq(1)
        expect(metrics.last_failure_time).to eq(now)
        expect(metrics.average_response_time).to eq(0.2)
      end
    end

    describe '#record_rejection' do
      it 'increments rejected_calls only' do
        metrics.record_rejection

        expect(metrics.rejected_calls).to eq(1)
        expect(metrics.total_calls).to eq(0)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.failed_calls).to eq(0)
      end
    end

    describe '#record_state_transition' do
      it 'increments state_transitions' do
        expect do
          metrics.record_state_transition
        end.to change(metrics, :state_transitions).from(0).to(1)
      end
    end

    describe '#average_response_time' do
      it 'returns 0 when there are no response times' do
        expect(metrics.average_response_time).to eq(0)
      end

      it 'returns the arithmetic mean of response times' do
        metrics.record_success(0.1)
        metrics.record_failure(0.3)
        expect(metrics.average_response_time).to eq(0.2)
      end
    end

    describe '#to_h' do
      it 'returns ISO8601 timestamps when present' do
        t1 = Time.utc(2020, 1, 1, 0, 0, 0)
        t2 = Time.utc(2020, 1, 1, 0, 0, 1)

        allow(Time).to receive(:now).and_return(t1)
        metrics.record_failure(0.5)

        allow(Time).to receive(:now).and_return(t2)
        metrics.record_success(1.0)

        h = metrics.to_h
        expect(h[:total_calls]).to eq(2)
        expect(h[:failed_calls]).to eq(1)
        expect(h[:successful_calls]).to eq(1)
        expect(h[:rejected_calls]).to eq(0)
        expect(h[:state_transitions]).to eq(0)
        expect(h[:last_failure_time]).to eq(t1.iso8601)
        expect(h[:last_success_time]).to eq(t2.iso8601)
        expect(h[:average_response_time_ms]).to eq(750.0)
      end

      it 'returns nil timestamps when never set' do
        h = metrics.to_h
        expect(h[:last_failure_time]).to be_nil
        expect(h[:last_success_time]).to be_nil
      end
    end
  end

  describe CircuitBreaker::Breaker do
    let(:config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 2,
        timeout_seconds: 10.0,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
    end

    let(:breaker) { described_class.new('svc', config: config) }

    describe '.get_or_create' do
      it 'returns the same instance for the same name' do
        b1 = described_class.get_or_create('singleton-test')
        b2 = described_class.get_or_create('singleton-test')
        expect(b1).to be(b2)
      end

      it 'returns different instances for different names' do
        b1 = described_class.get_or_create('singleton-test-a')
        b2 = described_class.get_or_create('singleton-test-b')
        expect(b1).not_to be(b2)
      end
    end

    describe '.registry' do
      it 'returns a duplicate hash (mutating returned hash does not change internal registry)' do
        described_class.get_or_create('registry-copy-test')
        reg = described_class.registry
        expect(reg).to be_a(Hash)

        expect do
          reg['registry-copy-test'] = :mutated
        end.not_to raise_error

        reg2 = described_class.registry
        expect(reg2['registry-copy-test']).to be_a(described_class)
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

      context 'when closed and block succeeds' do
        it 'returns the block result and records success' do
          result = breaker.execute do
            123
          end

          expect(result).to eq(123)
          expect(breaker.metrics.total_calls).to eq(1)
          expect(breaker.metrics.successful_calls).to eq(1)
          expect(breaker.metrics.failed_calls).to eq(0)
          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
        end

        it 'reduces failure_count by 1 (to a minimum of 0) on success in closed state' do
          allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))

          expect do
            breaker.execute do
              raise 'boom'
            end
          end.to raise_error(RuntimeError, 'boom')

          expect(breaker.health_info[:failure_count]).to eq(1)

          allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 1))

          breaker.execute dook
          end

          expect(breaker.health_info[:failure_count]).to eq(0)
        end
      end

      context 'when closed and block raises' do
        it 're-raises the error and records failure' do
          expect do
            breaker.execute do
              raise StandardError, 'fail'
            end
          end.to raise_error(StandardError, 'fail')

          expect(breaker.metrics.total_calls).to eq(1)
          expect(breaker.metrics.failed_calls).to eq(1)
          expect(breaker.metrics.successful_calls).to eq(0)
        end

        it 'opens after reaching failure_threshold' do
          expect do
            breaker.execute do
              raise 'x'
            end
          end.to raise_error(RuntimeError)

          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          expect do
            breaker.execute do
              raise 'y'
            end
          end.to raise_error(RuntimeError)

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        end

        it 'opens when sliding window failure rate meets/exceeds threshold even if failure count below threshold' do
          low_failure_count_config = CircuitBreaker::Config.new(
            failure_threshold: 999,
            success_threshold: 1,
            timeout_seconds: 10.0,
            half_open_max_calls: 1,
            sliding_window_size: 4,
            failure_rate_threshold: 0.5
          )
          b = described_class.new('svc-rate', config: low_failure_count_config)

          b.execute dook
          end

          expect do
            b.execute do
              raise 'bad'
            end
          end.to raise_error(RuntimeError)

          expect(b.state).to eq(CircuitBreaker::State::CLOSED)

          expect do
            b.execute do
              raise 'bad2'
            end
          end.to raise_error(RuntimeError)

          expect(b.state).to eq(CircuitBreaker::State::OPEN)
        end
      end

      context 'when open' do
        let(:open_config) do
          CircuitBreaker::Config.new(
            failure_threshold: 1,
            success_threshold: 1,
            timeout_seconds: 30.0,
            half_open_max_calls: 1,
            sliding_window_size: 2,
            failure_rate_threshold: 1.0
          )
        end

        let(:open_breaker) { described_class.new('svc-open', config: open_config) }

        before do
          allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))
          expect do
            open_breaker.execute do
              raise 'boom'
            end
          end.to raise_error(RuntimeError, 'boom')
          expect(open_breaker.state).to eq(CircuitBreaker::State::OPEN)
        end

        it 'rejects calls with OpenError and records rejection when no fallback provided' do
          allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 1))

          expect do
            open_breaker.execute doshould_not_run
            end
          end.to raise_error(CircuitBreaker::OpenError)

          expect(open_breaker.metrics.rejected_calls).to eq(1)
          expect(open_breaker.metrics.total_calls).to eq(1)
        end

        it 'returns fallback value and records rejection when fallback provided' do
          allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 1))

          ran = false
          result = open_breaker.execute(fallback: -> { :fb }) do
            ran = true
            :value
          end

          expect(result).to eq(:fb)
          expect(ran).to eq(false)
          expect(open_breaker.metrics.rejected_calls).to eq(1)
        end

        it 'includes remaining time in OpenError' do
          allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 5))

          expect do
            open_breaker.execute donope
            end
          end.to raise_error(CircuitBreaker::OpenError) do |e|
            expect(e.name).to eq('svc-open')
            expect(e.remaining_time).to be_within(0.01).of(25.0)
          end
        end
      end
    end

    describe '#state' do
      it 'starts closed' do
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'transitions from OPEN to HALF_OPEN after timeout' do
        cfg = CircuitBreaker::Config.new(
          failure_threshold: 1,
          success_threshold: 2,
          timeout_seconds: 10.0,
          half_open_max_calls: 2,
          sliding_window_size: 2,
          failure_rate_threshold: 1.0
        )
        b = described_class.new('svc-reset', config: cfg)

        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))
        expect do
          b.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError)

        expect(b.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 11))
        expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)
        expect(b.metrics.state_transitions).to eq(2)
      end
    end

    describe '#health_info' do
      it 'returns a structured hash including metrics and config' do
        breaker.execute dook
        end

        h = breaker.health_info
        expect(h[:name]).to eq('svc')
        expect(h[:state]).to eq('CLOSED')
        expect(h[:failure_count]).to be_a(Integer)
        expect(h[:success_count]).to be_a(Integer)
        expect(h[:failure_rate]).to be_a(Float)
        expect(h[:metrics]).to be_a(Hash)
        expect(h[:config]).to eq(
          failure_threshold: config.failure_threshold,
          success_threshold: config.success_threshold,
          timeout_seconds: config.timeout_seconds
        )
      end

      it 'reports HALF_OPEN state after timeout and shows updated counters' do
        cfg = CircuitBreaker::Config.new(
          failure_threshold: 1,
          success_threshold: 2,
          timeout_seconds: 1.0,
          half_open_max_calls: 2,
          sliding_window_size: 2,
          failure_rate_threshold: 1.0
        )
        b = described_class.new('svc-hi', config: cfg)

        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))
        expect do
          b.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError)

        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 2))
        expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)

        info = b.health_info
        expect(info[:state]).to eq('HALF_OPEN')
        expect(info[:failure_count]).to eq(1)
      end
    end

    describe 'half-open behavior' do
      let(:cfg) do
        CircuitBreaker::Config.new(
          failure_threshold: 1,
          success_threshold: 2,
          timeout_seconds: 1.0,
          half_open_max_calls: 2,
          sliding_window_size: 4,
          failure_rate_threshold: 1.0
        )
      end

      let(:b) { described_class.new('svc-half', config: cfg) }

      before do
        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))
        expect do
          b.execute do
            raise 'fail'
          end
        end.to raise_error(RuntimeError)
        expect(b.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 2))
        expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)
      end

      it 'allows up to half_open_max_calls and then rejects further calls' do
        r1 = b.execute dook1
        end
        expect(r1).to eq(:ok1)

        r2 = b.execute dook2
        end
        expect(r2).to eq(:ok2)

        expect do
          b.execute dook3
          end
        end.to raise_error(CircuitBreaker::OpenError)

        expect(b.metrics.rejected_calls).to eq(1)
      end

      it 'closes after success_threshold successes in HALF_OPEN' do
        b.execute dook1
        end
        expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)

        b.execute dook2
        end
        expect(b.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 're-opens immediately on a failure in HALF_OPEN' do
        expect do
          b.execute do
            raise 'nope'
          end
        end.to raise_error(RuntimeError, 'nope')

        expect(b.state).to eq(CircuitBreaker::State::OPEN)
      end
    end
  end

  describe CircuitBreaker::DistributedCoordinator do
    let(:base_url) { 'http://coordinator.test' }
    let(:sync_interval) { 0.01 }
    let(:coordinator) { described_class.new(base_url, sync_interval: sync_interval) }

    let(:breaker_config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 2,
        timeout_seconds: 1.0,
        half_open_max_calls: 1,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
    end

    let(:breaker) { CircuitBreaker::Breaker.new('svc-dist', config: breaker_config) }

    def build_http_double(response: nil)
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)
      http
    end

    describe '#register' do
      it 'stores breaker and sends registration request' do
        response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
        http = build_http_double(response: response)

        expect(http).to receive(:request) do |req|
          expect(req).to be_a(Net::HTTP::Post)
          expect(req['Content-Type']).to eq('application/json')
          payload = JSON.parse(req.body)
          expect(payload['service']).to eq('svc-dist')
          expect(payload['failure_threshold']).to eq(breaker.config.failure_threshold)
          expect(payload['success_threshold']).to eq(breaker.config.success_threshold)
        end.and_return(response)

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end

      it 'swallows Net::HTTP errors during registration' do
        http = build_http_double(response: nil)
        allow(http).to receive(:request).and_raise(StandardError, 'network down')

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end
    end

    describe '#start_sync and #stop_sync' do
      it 'starts a background thread and stops it' do
        response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
        http = build_http_double(response: response)
        allow(http).to receive(:request).and_return(response)

        coordinator.register(breaker)
        coordinator.start_sync

        expect do
          sleep(sync_interval * 3)
        end.not_to raise_error

        expect do
          coordinator.stop_sync
        end.not_to raise_error
      end
    end

    describe '#get_cluster_state' do
      it 'returns parsed JSON response on success' do
        uri = URI("#{base_url}/circuit-breakers/svc/aggregate")
        response = instance_double(Net::HTTPResponse, body: '{"state":"OK"}')

        allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)

        result = coordinator.get_cluster_state('svc')
        expect(result).to eq({ 'state' => 'OK' })
      end

      it 'returns an error hash on failure' do
        uri = URI("#{base_url}/circuit-breakers/svc/aggregate")
        allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError, 'bad')

        result = coordinator.get_cluster_state('svc')
        expect(result).to eq({ error: 'bad' })
      end
    end
  end
end
