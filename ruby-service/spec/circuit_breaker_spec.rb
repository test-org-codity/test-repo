# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmphadbhl5i.rb:278: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
...{ :fallback }) doshould_not_run
...               ^~~~~~~~~~~~~~~~
/tmp/tmphadbhl5i.rb:317: syntax error, unexpected `end'
        end
        ^~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker do
  describe CircuitBreaker::OpenError do
    describe '#initialize' do
      it 'stores name and remaining_time and formats message' do
        error = described_class.new('svc', 1.23456)

        expect(error.name).to eq('svc')
        expect(error.remaining_time).to eq(1.23456)
        expect(error.message).to include("Circuit breaker 'svc' is open")
        expect(error.message).to include('Retry after')
      end

      it 'rounds remaining_time in message to two decimals' do
        error = described_class.new('svc', 1.239)

        expect(error.message).to include('1.24s')
      end
    end
  end

  describe CircuitBreaker::State do
    describe '.all' do
      it 'returns all valid states' do
        expect(described_class.all).to contain_exactly(:closed, :open, :half_open)
      end
    end
  end

  describe CircuitBreaker::Config do
    describe '#initialize' do
      it 'sets defaults' do
        config = described_class.new

        expect(config.failure_threshold).to eq(5)
        expect(config.success_threshold).to eq(3)
        expect(config.timeout_seconds).to eq(30.0)
        expect(config.half_open_max_calls).to eq(3)
        expect(config.sliding_window_size).to eq(10)
        expect(config.failure_rate_threshold).to eq(0.5)
      end

      it 'allows overriding values' do
        config = described_class.new(
          failure_threshold: 2,
          success_threshold: 1,
          timeout_seconds: 0.25,
          half_open_max_calls: 2,
          sliding_window_size: 4,
          failure_rate_threshold: 0.75
        )

        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(1)
        expect(config.timeout_seconds).to eq(0.25)
        expect(config.half_open_max_calls).to eq(2)
        expect(config.sliding_window_size).to eq(4)
        expect(config.failure_rate_threshold).to eq(0.75)
      end
    end
  end

  describe CircuitBreaker::Metrics do
    let(:metrics) { described_class.new }

    describe '#record_success' do
      it 'increments successful_calls and total_calls and sets last_success_time' do
        fixed_time = Time.at(1_700_000_000)
        allow(Time).to receive(:now).and_return(fixed_time)

        metrics.record_success(0.05)

        expect(metrics.successful_calls).to eq(1)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.total_calls).to eq(1)
        expect(metrics.last_success_time).to eq(fixed_time)
        expect(metrics.last_failure_time).to be_nil
      end
    end

    describe '#record_failure' do
      it 'increments failed_calls and total_calls and sets last_failure_time' do
        fixed_time = Time.at(1_700_000_100)
        allow(Time).to receive(:now).and_return(fixed_time)

        metrics.record_failure(0.12)

        expect(metrics.failed_calls).to eq(1)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.total_calls).to eq(1)
        expect(metrics.last_failure_time).to eq(fixed_time)
        expect(metrics.last_success_time).to be_nil
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
        metrics.record_state_transition
        metrics.record_state_transition

        expect(metrics.state_transitions).to eq(2)
      end
    end

    describe '#average_response_time' do
      it 'returns 0 when no response times exist' do
        expect(metrics.average_response_time).to eq(0)
      end

      it 'returns the average of recorded response times' do
        metrics.record_success(0.1)
        metrics.record_failure(0.3)

        expect(metrics.average_response_time).to be_within(1e-9).of(0.2)
      end

      it 'keeps only the last 100 response times' do
        150.times do
          metrics.record_success(0.01)
        end

        expect(metrics.average_response_time).to be_within(1e-9).of(0.01)
      end
    end

    describe '#to_h' do
      it 'returns a hash with expected keys and ISO8601 times when present' do
        fixed_time = Time.at(1_700_000_200).utc
        allow(Time).to receive(:now).and_return(fixed_time)

        metrics.record_failure(0.2)
        metrics.record_success(0.4)

        data = nil
        expect do
          data = metrics.to_h
        end.not_to raise_error

        expect(data).to be_a(Hash)
        expect(data[:total_calls]).to eq(2)
        expect(data[:successful_calls]).to eq(1)
        expect(data[:failed_calls]).to eq(1)
        expect(data[:rejected_calls]).to eq(0)
        expect(data[:state_transitions]).to eq(0)
        expect(data[:average_response_time_ms]).to eq(300.0)
        expect(data[:last_failure_time]).to be_a(String)
        expect(data[:last_success_time]).to be_a(String)
      end

      it 'includes nil times when no success/failure recorded' do
        data = nil
        expect do
          data = metrics.to_h
        end.not_to raise_error

        expect(data[:last_failure_time]).to be_nil
        expect(data[:last_success_time]).to be_nil
        expect(data[:average_response_time_ms]).to eq(0.0)
      end
    end
  end

  describe CircuitBreaker::Breaker do
    describe '.get_or_create' do
      it 'returns the same instance for the same name' do
        b1 = described_class.get_or_create('service-a')
        b2 = described_class.get_or_create('service-a')

        expect(b1).to be_a(described_class)
        expect(b1).to equal(b2)
      end

      it 'creates different instances for different names' do
        b1 = described_class.get_or_create('service-a')
        b2 = described_class.get_or_create('service-b')

        expect(b1).not_to equal(b2)
      end
    end

    describe '.registry' do
      it 'returns a duplicate of the registry hash' do
        described_class.get_or_create('reg-svc-1')

        reg1 = described_class.registry
        reg1['reg-svc-2'] = :mutated

        reg2 = described_class.registry
        expect(reg2['reg-svc-2']).to be_nil
      end
    end

    describe '#execute' do
      let(:config) do
        CircuitBreaker::Config.new(
          failure_threshold: 2,
          success_threshold: 2,
          timeout_seconds: 0.1,
          half_open_max_calls: 1,
          sliding_window_size: 4,
          failure_rate_threshold: 0.75
        )
      end

      let(:breaker) { described_class.new('svc', config: config) }

      it 'raises ArgumentError when no block is given' do
        expect do
          breaker.execute
        end.to raise_error(ArgumentError, 'Block required')
      end

      it 'returns the block result when closed and successful' do
        result = breaker.execute do
          123
        end

        expect(result).to eq(123)
        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.metrics.successful_calls).to eq(1)
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'records a failure and re-raises errors from the block' do
        expect do
          breaker.execute do
            raise StandardError, 'boom'
          end
        end.to raise_error(StandardError, 'boom')

        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.metrics.failed_calls).to eq(1)
      end

      context 'when failure_threshold is reached' do
        it 'opens the circuit and rejects subsequent calls with OpenError' do
          2.times do
            expect do
              breaker.execute do
                raise StandardError, 'fail'
              end
            end.to raise_error(StandardError, 'fail')
          end

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          expect do
            breaker.execute do
              1
            end
          end.to raise_error(CircuitBreaker::OpenError)

          expect(breaker.metrics.rejected_calls).to eq(1)
        end

        it 'returns fallback result when provided instead of raising OpenError' do
          2.times do
            expect do
              breaker.execute do
                raise StandardError, 'fail'
              end
            end.to raise_error(StandardError)
          end

          value = breaker.execute(fallback: -> { :fallback }) doshould_not_run
          end

          expect(value).to eq(:fallback)
          expect(breaker.metrics.rejected_calls).to eq(1)
        end
      end

      context 'when timeout elapses after opening' do
        it 'transitions to HALF_OPEN on state check and allows a limited trial call' do
          now = Time.at(1_700_000_000.0)
          allow(Time).to receive(:now).and_return(now)

          2.times do
            expect do
              breaker.execute do
                raise StandardError, 'fail'
              end
            end.to raise_error(StandardError)
          end

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          allow(Time).to receive(:now).and_return(now + 0.2)

          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          result = breaker.execute dook
          end
          expect(result).to eq(:ok)

          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          expect do
            breaker.execute dosecond_call_rejected
            end
          end.to raise_error(CircuitBreaker::OpenError)

          expect(breaker.metrics.rejected_calls).to eq(1)
        end

        it 'closes the circuit after enough half-open successes' do
          now = Time.at(1_700_000_000.0)
          allow(Time).to receive(:now).and_return(now)

          2.times do
            expect do
              breaker.execute do
                raise StandardError, 'fail'
              end
            end.to raise_error(StandardError)
          end

          allow(Time).to receive(:now).and_return(now + 0.2)
          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          breaker.execute dook1
          end

          allow(Time).to receive(:now).and_return(now + 0.21)
          breaker.execute dook2
          end

          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          expect do
            breaker.execute doworks
            end
          end.not_to raise_error

          expect(breaker.metrics.rejected_calls).to eq(0)
        end

        it 're-opens immediately if a half-open trial call fails' do
          now = Time.at(1_700_000_000.0)
          allow(Time).to receive(:now).and_return(now)

          2.times do
            expect do
              breaker.execute do
                raise StandardError, 'fail'
              end
            end.to raise_error(StandardError)
          end

          allow(Time).to receive(:now).and_return(now + 0.2)
          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

          expect do
            breaker.execute do
              raise StandardError, 'trial fails'
            end
          end.to raise_error(StandardError, 'trial fails')

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        end
      end

      context 'when failure rate crosses threshold before failure count threshold' do
        it 'opens based on failure_rate_threshold' do
          rate_config = CircuitBreaker::Config.new(
            failure_threshold: 99,
            success_threshold: 1,
            timeout_seconds: 10.0,
            half_open_max_calls: 1,
            sliding_window_size: 4,
            failure_rate_threshold: 0.5
          )
          b = described_class.new('rate-svc', config: rate_config)

          expect do
            b.execute do
              raise StandardError, 'f1'
            end
          end.to raise_error(StandardError)

          expect do
            b.execute do
              raise StandardError, 'f2'
            end
          end.to raise_error(StandardError)

          expect(b.state).to eq(CircuitBreaker::State::OPEN)
        end
      end
    end

    describe '#state' do
      it 'returns CLOSED by default' do
        breaker = described_class.new('svc-state')
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end
    end

    describe '#health_info' do
      it 'returns the health hash with required fields' do
        config = CircuitBreaker::Config.new(
          failure_threshold: 1,
          success_threshold: 1,
          timeout_seconds: 1.0,
          sliding_window_size: 2,
          failure_rate_threshold: 1.0
        )
        breaker = described_class.new('svc-health', config: config)

        expect do
          breaker.execute do
            raise StandardError, 'fail'
          end
        end.to raise_error(StandardError)

        info = breaker.health_info

        expect(info[:name]).to eq('svc-health')
        expect(info[:state]).to be_a(String)
        expect(info[:state]).to eq('OPEN')
        expect(info[:failure_count]).to be >= 1
        expect(info[:success_count]).to be_a(Integer)
        expect(info[:failure_rate]).to be_between(0.0, 1.0)
        expect(info[:metrics]).to be_a(Hash)
        expect(info[:config]).to include(
          failure_threshold: 1,
          success_threshold: 1,
          timeout_seconds: 1.0
        )
      end
    end
  end

  describe CircuitBreaker::DistributedCoordinator do
    let(:coordinator_url) { 'http://coordinator.test:8080' }
    let(:sync_interval) { 0.01 }
    let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }

    let(:config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 1,
        timeout_seconds: 0.1,
        half_open_max_calls: 1,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
    end

    let(:breaker) { CircuitBreaker::Breaker.new('svc-coord', config: config) }

    describe '#initialize' do
      it 'sets a node_id using ENV[NODE_ID] when present' do
        begin
          old_node_id = ENV['NODE_ID']
          ENV['NODE_ID'] = 'node-123'
          instance = described_class.new(coordinator_url, sync_interval: sync_interval)

          node_id = instance.instance_variable_get(:@node_id)
          expect(node_id).to eq('node-123')
        ensure
          ENV['NODE_ID'] = old_node_id
        end
      end
    end

    describe '#register' do
      it 'stores breaker and sends registration (http request is attempted)' do
        http = instance_double(Net::HTTP)
        response = instance_double(Net::HTTPResponse, body: '{}')
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_return(response)

        expect do
          coordinator.register(breaker)
        end.not_to raise_error

        breakers_hash = coordinator.instance_variable_get(:@breakers)
        expect(breakers_hash[breaker.name]).to eq(breaker)
      end

      it 'swallows exceptions from registration request' do
        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=).and_raise(StandardError, 'net down')
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request)

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end
    end

    describe '#start_sync and #stop_sync' do
      it 'starts a background thread and stops it' do
        allow(coordinator).to receive(:sleep)

        http = instance_double(Net::HTTP)
        response = instance_double(Net::HTTPResponse, body: '{}')
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_return(response)

        coordinator.register(breaker)

        expect do
          coordinator.start_sync
        end.not_to raise_error

        t = coordinator.instance_variable_get(:@sync_thread)
        expect(t).to be_a(Thread)

        expect do
          coordinator.stop_sync
        end.not_to raise_error
      end
    end

    describe '#get_cluster_state' do
      it 'returns parsed JSON on success' do
        response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
        allow(Net::HTTP).to receive(:get_response).and_return(response)

        data = coordinator.get_cluster_state('svc-a')
        expect(data).to eq({ 'ok' => true })
      end

      it 'returns an error hash when an exception occurs' do
        allow(Net::HTTP).to receive(:get_response).and_raise(StandardError, 'boom')

        data = coordinator.get_cluster_state('svc-a')
        expect(data).to eq({ error: 'boom' })
      end
    end
  end
end
