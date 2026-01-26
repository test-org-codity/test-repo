require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker do
  describe CircuitBreaker::OpenError do
    describe '#initialize' do
      it 'sets name and remaining_time and formats the message' do
        error = described_class.new('payments', 1.23456)

        expect(error.name).to eq('payments')
        expect(error.remaining_time).to eq(1.23456)
        expect(error.message).to include("Circuit breaker 'payments' is open")
        expect(error.message).to include('Retry after 1.23s')
      end
    end
  end

  describe CircuitBreaker::State do
    describe '.all' do
      it 'returns all valid states' do
        expect(described_class.all).to match_array(%i[closed open half_open])
      end
    end
  end

  describe CircuitBreaker::Config do
    describe '#initialize' do
      it 'has sensible defaults' do
        config = described_class.new

        expect(config.failure_threshold).to eq(5)
        expect(config.success_threshold).to eq(3)
        expect(config.timeout_seconds).to eq(30.0)
        expect(config.half_open_max_calls).to eq(3)
        expect(config.sliding_window_size).to eq(10)
        expect(config.failure_rate_threshold).to eq(0.5)
      end

      it 'accepts overrides' do
        config = described_class.new(
          failure_threshold: 2,
          success_threshold: 1,
          timeout_seconds: 0.25,
          half_open_max_calls: 1,
          sliding_window_size: 4,
          failure_rate_threshold: 0.75
        )

        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(1)
        expect(config.timeout_seconds).to eq(0.25)
        expect(config.half_open_max_calls).to eq(1)
        expect(config.sliding_window_size).to eq(4)
        expect(config.failure_rate_threshold).to eq(0.75)
      end
    end
  end

  describe CircuitBreaker::Metrics do
    let(:metrics) { described_class.new }

    describe '#initialize' do
      it 'starts with zeroed counters and nil timestamps' do
        expect(metrics.total_calls).to eq(0)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.rejected_calls).to eq(0)
        expect(metrics.state_transitions).to eq(0)
        expect(metrics.last_failure_time).to be_nil
        expect(metrics.last_success_time).to be_nil
      end
    end

    describe '#record_success' do
      it 'increments successful and total calls and stores success time' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        metrics.record_success(0.1)

        expect(metrics.successful_calls).to eq(1)
        expect(metrics.total_calls).to eq(1)
        expect(metrics.last_success_time).to eq(now)
        expect(metrics.failed_calls).to eq(0)
      end

      it 'keeps only the last 100 response times for average' do
        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))

        150.times do
          metrics.record_success(1.0)
        end

        expect(metrics.total_calls).to eq(150)
        expect(metrics.average_response_time).to eq(1.0)
      end
    end

    describe '#record_failure' do
      it 'increments failed and total calls and stores failure time' do
        now = Time.utc(2020, 1, 1, 0, 0, 1)
        allow(Time).to receive(:now).and_return(now)

        metrics.record_failure(0.2)

        expect(metrics.failed_calls).to eq(1)
        expect(metrics.total_calls).to eq(1)
        expect(metrics.last_failure_time).to eq(now)
        expect(metrics.successful_calls).to eq(0)
      end
    end

    describe '#record_rejection' do
      it 'increments rejected calls without increasing total_calls' do
        metrics.record_rejection

        expect(metrics.rejected_calls).to eq(1)
        expect(metrics.total_calls).to eq(0)
      end
    end

    describe '#record_state_transition' do
      it 'increments state transitions' do
        metrics.record_state_transition
        metrics.record_state_transition

        expect(metrics.state_transitions).to eq(2)
      end
    end

    describe '#average_response_time' do
      it 'returns 0 when no calls recorded' do
        expect(metrics.average_response_time).to eq(0)
      end

      it 'returns the average of recorded response times' do
        allow(Time).to receive(:now).and_return(Time.utc(2020, 1, 1, 0, 0, 0))

        metrics.record_success(0.1)
        metrics.record_failure(0.3)

        expect(metrics.average_response_time).to be_within(0.000001).of(0.2)
      end
    end

    describe '#to_h' do
      it 'returns a hash with aggregated metric fields and ISO8601 timestamps' do
        t1 = Time.utc(2020, 1, 1, 0, 0, 0)
        t2 = Time.utc(2020, 1, 1, 0, 0, 2)
        allow(Time).to receive(:now).and_return(t1, t2)

        metrics.record_success(0.05)
        metrics.record_failure(0.15)
        metrics.record_rejection
        metrics.record_state_transition

        h = metrics.to_h

        expect(h[:total_calls]).to eq(2)
        expect(h[:successful_calls]).to eq(1)
        expect(h[:failed_calls]).to eq(1)
        expect(h[:rejected_calls]).to eq(1)
        expect(h[:state_transitions]).to eq(1)
        expect(h[:average_response_time_ms]).to be_within(0.01).of(100.0)
        expect(h[:last_success_time]).to eq(t1.iso8601)
        expect(h[:last_failure_time]).to eq(t2.iso8601)
      end
    end
  end

  describe CircuitBreaker::Breaker do
    let(:config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 2,
        timeout_seconds: 0.5,
        half_open_max_calls: 1,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
    end
    let(:breaker) { described_class.new('svc', config: config) }

    describe '.get_or_create' do
      it 'creates and returns a breaker and reuses it for the same name' do
        b1 = described_class.get_or_create('registry-svc', config: config)
        b2 = described_class.get_or_create('registry-svc', config: CircuitBreaker::Config.new(failure_threshold: 999))

        expect(b1).to be_a(described_class)
        expect(b2.object_id).to eq(b1.object_id)
        expect(b2.name).to eq('registry-svc')
      end
    end

    describe '.registry' do
      it 'returns a duplicate of the registry hash' do
        described_class.get_or_create('dup-svc', config: config)

        r1 = described_class.registry
        r2 = described_class.registry

        expect(r1).to be_a(Hash)
        expect(r2).to be_a(Hash)
        expect(r1.object_id).not_to eq(r2.object_id)
        expect(r1.keys).to include('dup-svc')
      end
    end

    describe '#execute' do
      context 'when block is not given' do
        it 'raises ArgumentError' do
          expect do
            breaker.execute
          end.to raise_error(ArgumentError, 'Block required')
        end
      end

      context 'when circuit is closed and block succeeds' do
        it 'returns the block result and records success metrics' do
          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          result = breaker.execute do
            'ok'
          end

          expect(result).to eq('ok')
          expect(breaker.metrics.total_calls).to eq(1)
          expect(breaker.metrics.successful_calls).to eq(1)
          expect(breaker.metrics.failed_calls).to eq(0)
          expect(breaker.metrics.rejected_calls).to eq(0)
        end
      end

      context 'when circuit is closed and block raises' do
        it 're-raises and records failure metrics' do
          expect do
            breaker.execute do
              raise ArgumentError, 'boom'
            end
          end.to raise_error(ArgumentError, 'boom')

          expect(breaker.metrics.total_calls).to eq(1)
          expect(breaker.metrics.successful_calls).to eq(0)
          expect(breaker.metrics.failed_calls).to eq(1)
        end
      end

      context 'when failures reach the threshold' do
        it 'opens the circuit and rejects subsequent calls with OpenError' do
          expect do
            breaker.execute do
              raise StandardError, 'fail1'
            end
          end.to raise_error(StandardError, 'fail1')

          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          expect do
            breaker.execute do
              raise StandardError, 'fail2'
            end
          end.to raise_error(StandardError, 'fail2')

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          expect do
            breaker.execute do
              'should not run'
            end
          end.to raise_error(CircuitBreaker::OpenError)

          expect(breaker.metrics.rejected_calls).to eq(1)
        end

        it 'returns fallback instead of raising when provided' do
          2.times do
            breaker.execute do
              raise StandardError, 'fail'
            end
          rescue StandardError
          end

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          result = breaker.execute(fallback: -> { 'fallback' }) do
            'nope'
          end

          expect(result).to eq('fallback')
          expect(breaker.metrics.rejected_calls).to eq(1)
        end
      end

      context 'when failure rate threshold is exceeded within the sliding window' do
        let(:rate_config) do
          CircuitBreaker::Config.new(
            failure_threshold: 100,
            success_threshold: 1,
            timeout_seconds: 10.0,
            half_open_max_calls: 1,
            sliding_window_size: 4,
            failure_rate_threshold: 0.5
          )
        end
        let(:rate_breaker) { described_class.new('rate-svc', config: rate_config) }

        it 'opens based on failure_rate even when failure_count is below failure_threshold' do
          rate_breaker.execute do
            'ok'
          end

          begin
            rate_breaker.execute do
              raise StandardError, 'fail'
            end
          rescue StandardError
          end

          begin
            rate_breaker.execute do
              raise StandardError, 'fail'
            end
          rescue StandardError
          end

          expect(rate_breaker.state).to eq(CircuitBreaker::State::OPEN)

          expect do
            rate_breaker.execute do
              'nope'
            end
          end.to raise_error(CircuitBreaker::OpenError)
        end
      end

      context 'when open timeout elapses and breaker transitions to half-open' do
        it 'allows a limited number of half-open calls and closes after enough successes' do
          t0 = Time.utc(2020, 1, 1, 0, 0, 0)
          allow(Time).to receive(:now).and_return(t0, t0, t0, t0, t0 + 1.0, t0 + 1.0, t0 + 1.0, t0 + 1.0)

          2.times do
            breaker.execute do
              raise StandardError, 'fail'
            end
          rescue StandardError
          end

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          result1 = breaker.execute do
            'ok1'
          end
          expect(result1).to eq('ok1')

          expect do
            breaker.execute do
              'blocked'
            end
          end.to raise_error(CircuitBreaker::OpenError)

          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          result2 = breaker.execute do
            'ok2'
          end
          expect(result2).to eq('ok2')

          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          result3 = breaker.execute do
            'ok3'
          end
          expect(result3).to eq('ok3')
        end

        it 'reopens immediately if a half-open call fails' do
          t0 = Time.utc(2020, 1, 1, 0, 0, 0)
          allow(Time).to receive(:now).and_return(t0, t0, t0, t0, t0 + 1.0, t0 + 1.0, t0 + 1.0)

          2.times do
            breaker.execute do
              raise StandardError, 'fail'
            end
          rescue StandardError
          end

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          expect do
            breaker.execute do
              raise StandardError, 'half-open-fail'
            end
          end.to raise_error(StandardError, 'half-open-fail')

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          expect do
            breaker.execute do
              'blocked'
            end
          end.to raise_error(CircuitBreaker::OpenError)
        end
      end
    end

    describe '#state' do
      it 'returns current state and transitions from open to half-open after timeout' do
        t0 = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(t0, t0, t0, t0, t0 + 1.0)

        2.times do
          breaker.execute do
            raise StandardError, 'fail'
          end
        rescue StandardError
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      end
    end

    describe '#health_info' do
      it 'returns breaker metadata including metrics and config subset' do
        breaker.execute do
          'ok'
        end

        info = breaker.health_info

        expect(info[:name]).to eq('svc')
        expect(info[:state]).to eq('CLOSED')
        expect(info[:failure_count]).to be_a(Integer)
        expect(info[:success_count]).to be_a(Integer)
        expect(info[:failure_rate]).to be_a(Float)
        expect(info[:metrics]).to be_a(Hash)
        expect(info[:config]).to eq(
          failure_threshold: config.failure_threshold,
          success_threshold: config.success_threshold,
          timeout_seconds: config.timeout_seconds
        )
      end
    end
  end

  describe CircuitBreaker::DistributedCoordinator do
    let(:coordinator_url) { 'http://coordinator.test' }
    let(:sync_interval) { 0.01 }
    let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }
    let(:breaker_config) { CircuitBreaker::Config.new(failure_threshold: 2, success_threshold: 1, timeout_seconds: 0.1) }
    let(:breaker) { CircuitBreaker::Breaker.new('svc', config: breaker_config) }

    describe '#register' do
      it 'stores the breaker and attempts to send registration' do
        uri = instance_double(URI::HTTP, host: 'coordinator.test', port: 80)
        allow(URI).to receive(:[]).and_return(uri)

        response = instance_double(Net::HTTPResponse, body: 'ok')

        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_return(response)

        request = instance_double(Net::HTTP::Post)
        allow(Net::HTTP::Post).to receive(:new).with(uri).and_return(request)
        allow(request).to receive(:[]=)
        allow(request).to receive(:body=)

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end

      it 'swallows network errors during registration' do
        uri = instance_double(URI::HTTP, host: 'coordinator.test', port: 80)
        allow(URI).to receive(:[]).and_return(uri)

        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_raise(StandardError, 'network down')

        request = instance_double(Net::HTTP::Post)
        allow(Net::HTTP::Post).to receive(:new).and_return(request)
        allow(request).to receive(:[]=)
        allow(request).to receive(:body=)

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end
    end

    describe '#start_sync' do
      it 'starts a background thread that periodically synchronizes states' do
        allow(coordinator).to receive(:sleep)

        uri = instance_double(URI::HTTP, host: 'coordinator.test', port: 80)
        allow(URI).to receive(:[]).and_return(uri)

        response = instance_double(Net::HTTPResponse, body: 'ok')

        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_return(response)

        request = instance_double(Net::HTTP::Post)
        allow(Net::HTTP::Post).to receive(:new).and_return(request)
        allow(request).to receive(:[]=)
        allow(request).to receive(:body=)

        coordinator.register(breaker)

        expect(Thread).to receive(:new).and_call_original

        coordinator.start_sync
        coordinator.stop_sync
      end
    end

    describe '#stop_sync' do
      it 'stops the thread without raising even if never started' do
        expect do
          coordinator.stop_sync
        end.not_to raise_error
      end
    end

    describe '#get_cluster_state' do
      it 'fetches and parses JSON response from coordinator' do
        uri = instance_double(URI::HTTP)
        allow(URI).to receive(:[]).and_return(uri)

        response = instance_double(Net::HTTPResponse, body: '{"state":"OK","nodes":2}')
        allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)

        result = coordinator.get_cluster_state('svc')

        expect(result).to eq({ 'state' => 'OK', 'nodes' => 2 })
      end

      it 'returns an error hash when request fails' do
        uri = instance_double(URI::HTTP)
        allow(URI).to receive(:[]).and_return(uri)

        allow(Net::HTTP).to receive(:get_response).and_raise(StandardError, 'boom')

        result = coordinator.get_cluster_state('svc')

        expect(result).to eq({ error: 'boom' })
      end
    end
  end
end
