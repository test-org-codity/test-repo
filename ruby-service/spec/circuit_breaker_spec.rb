# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpkuj6pc3z.rb:358: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
...xecute(fallback: fallback) dook
...                           ^~~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker do
  describe CircuitBreaker::OpenError do
    describe '#initialize' do
      it 'sets name and remaining_time and formats message' do
        error = described_class.new('svc', 1.2345)
        expect(error.name).to eq('svc')
        expect(error.remaining_time).to eq(1.2345)
        expect(error.message).to include("Circuit breaker 'svc' is open")
        expect(error.message).to include('Retry after 1.23s')
      end
    end
  end

  describe CircuitBreaker::State do
    describe '.all' do
      it 'returns all states' do
        expect(described_class.all).to contain_exactly(:closed, :open, :half_open)
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

      it 'allows overriding values' do
        config = described_class.new(
          failure_threshold: 2,
          success_threshold: 4,
          timeout_seconds: 1.5,
          half_open_max_calls: 1,
          sliding_window_size: 6,
          failure_rate_threshold: 0.9
        )

        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(4)
        expect(config.timeout_seconds).to eq(1.5)
        expect(config.half_open_max_calls).to eq(1)
        expect(config.sliding_window_size).to eq(6)
        expect(config.failure_rate_threshold).to eq(0.9)
      end
    end
  end

  describe CircuitBreaker::Metrics do
    let(:metrics) { described_class.new }

    describe '#record_success' do
      it 'increments totals and stores last_success_time' do
        fixed_time = Time.at(1000)
        allow(Time).to receive(:now).and_return(fixed_time)

        metrics.record_success(0.05)

        expect(metrics.total_calls).to eq(1)
        expect(metrics.successful_calls).to eq(1)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.last_success_time).to eq(fixed_time)
        expect(metrics.last_failure_time).to be_nil
      end
    end

    describe '#record_failure' do
      it 'increments totals and stores last_failure_time' do
        fixed_time = Time.at(2000)
        allow(Time).to receive(:now).and_return(fixed_time)

        metrics.record_failure(0.07)

        expect(metrics.total_calls).to eq(1)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.failed_calls).to eq(1)
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
        expect do
          metrics.record_state_transition
        end.to change(metrics, :state_transitions).from(0).to(1)
      end
    end

    describe '#average_response_time' do
      it 'returns 0 when no response times recorded' do
        expect(metrics.average_response_time).to eq(0)
      end

      it 'returns average over recorded successes and failures' do
        allow(Time).to receive(:now).and_return(Time.at(1234))

        metrics.record_success(0.10)
        metrics.record_failure(0.30)

        expect(metrics.average_response_time).to be_within(0.000001).of(0.20)
      end
    end

    describe '#to_h' do
      it 'returns a hash with ISO8601 timestamps and average ms' do
        t_success = Time.at(10)
        t_failure = Time.at(20)

        allow(Time).to receive(:now).and_return(t_success)
        metrics.record_success(0.1234)

        allow(Time).to receive(:now).and_return(t_failure)
        metrics.record_failure(0.1000)

        data = metrics.to_h
        expect(data[:total_calls]).to eq(2)
        expect(data[:successful_calls]).to eq(1)
        expect(data[:failed_calls]).to eq(1)
        expect(data[:rejected_calls]).to eq(0)
        expect(data[:state_transitions]).to eq(0)
        expect(data[:average_response_time_ms]).to eq(((0.1234 + 0.1000) / 2.0 * 1000).round(2))
        expect(data[:last_success_time]).to eq(t_success.iso8601)
        expect(data[:last_failure_time]).to eq(t_failure.iso8601)
      end

      it 'does not raise when no timestamps exist' do
        expect do
          metrics.to_h
        end.not_to raise_error
      end
    end

    describe 'response time retention' do
      it 'keeps only the last 100 response times' do
        allow(Time).to receive(:now).and_return(Time.at(1))
        150.times do |i|
          metrics.record_success(i / 1000.0)
        end

        expected_avg = (50..149).sum / 1000.0 / 100.0
        expect(metrics.average_response_time).to be_within(0.000001).of(expected_avg)
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
        failure_rate_threshold: 0.75
      )
    end

    let(:breaker) { described_class.new('svc', config: config) }

    describe '.get_or_create' do
      it 'returns the same instance for the same name' do
        b1 = described_class.get_or_create('same-name')
        b2 = described_class.get_or_create('same-name')
        expect(b1).to be(b2)
      end

      it 'returns different instances for different names' do
        b1 = described_class.get_or_create('name-1')
        b2 = described_class.get_or_create('name-2')
        expect(b1).not_to be(b2)
      end
    end

    describe '.registry' do
      it 'returns a duplicate hash that is safe to mutate without affecting internal registry' do
        described_class.get_or_create('registry-test')
        reg = described_class.registry
        expect(reg).to be_a(Hash)
        reg['registry-test'] = :mutated
        expect(described_class.registry['registry-test']).to be_a(described_class)
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

      context 'when the breaker is closed and block succeeds' do
        it 'returns the block result and records success' do
          allow(Time).to receive(:now).and_return(Time.at(1000), Time.at(1000.2))

          result = breaker.execute dook
          end

          expect(result).to eq(:ok)
          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          m = breaker.metrics
          expect(m.total_calls).to eq(1)
          expect(m.successful_calls).to eq(1)
          expect(m.failed_calls).to eq(0)
          expect(m.rejected_calls).to eq(0)
        end

        it 'reduces failure_count by 1 but not below 0 on success' do
          allow(Time).to receive(:now).and_return(Time.at(1), Time.at(1.01))
          begin
            breaker.execute do
              raise 'boom'
            end
          rescue StandardError
          end

          health_after_failure = breaker.health_info
          expect(health_after_failure[:failure_count]).to eq(1)

          allow(Time).to receive(:now).and_return(Time.at(2), Time.at(2.01))
          breaker.execute dook
          end

          health_after_success = breaker.health_info
          expect(health_after_success[:failure_count]).to eq(0)
        end
      end

      context 'when the breaker is closed and block raises' do
        it 're-raises the error and records failure' do
          allow(Time).to receive(:now).and_return(Time.at(1000), Time.at(1000.05))

          expect do
            breaker.execute do
              raise ArgumentError, 'bad'
            end
          end.to raise_error(ArgumentError, 'bad')

          m = breaker.metrics
          expect(m.total_calls).to eq(1)
          expect(m.successful_calls).to eq(0)
          expect(m.failed_calls).to eq(1)
        end

        it 'opens when failure_threshold is reached' do
          allow(Time).to receive(:now).and_return(Time.at(10), Time.at(10.01))
          expect do
            breaker.execute do
              raise 'fail 1'
            end
          end.to raise_error(RuntimeError, 'fail 1')

          allow(Time).to receive(:now).and_return(Time.at(11), Time.at(11.01))
          expect do
            breaker.execute do
              raise 'fail 2'
            end
          end.to raise_error(RuntimeError, 'fail 2')

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        end

        it 'opens when failure rate in sliding window meets threshold' do
          cfg = CircuitBreaker::Config.new(
            failure_threshold: 100,
            success_threshold: 2,
            timeout_seconds: 10.0,
            half_open_max_calls: 2,
            sliding_window_size: 4,
            failure_rate_threshold: 0.75
          )
          b = described_class.new('rate-svc', config: cfg)

          allow(Time).to receive(:now).and_return(Time.at(1), Time.at(1.01))
          expect do
            b.execute do
              raise 'f1'
            end
          end.to raise_error(RuntimeError, 'f1')

          allow(Time).to receive(:now).and_return(Time.at(2), Time.at(2.01))
          expect do
            b.execute do
              raise 'f2'
            end
          end.to raise_error(RuntimeError, 'f2')

          allow(Time).to receive(:now).and_return(Time.at(3), Time.at(3.01))
          expect do
            b.execute do
              raise 'f3'
            end
          end.to raise_error(RuntimeError, 'f3')

          expect(b.state).to eq(CircuitBreaker::State::OPEN)
        end
      end

      context 'when the breaker is open' do
        before do
          allow(Time).to receive(:now).and_return(Time.at(10), Time.at(10.01))
          begin
            breaker.execute do
              raise 'fail 1'
            end
          rescue StandardError
          end

          allow(Time).to receive(:now).and_return(Time.at(11), Time.at(11.01))
          begin
            breaker.execute do
              raise 'fail 2'
            end
          rescue StandardError
          end

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        end

        it 'rejects requests with OpenError when no fallback is provided' do
          allow(Time).to receive(:now).and_return(Time.at(12))
          expect do
            breaker.execute dook
            end
          end.to raise_error(CircuitBreaker::OpenError) do |e|
            expect(e.name).to eq('svc')
            expect(e.remaining_time).to be >= 0
          end

          expect(breaker.metrics.rejected_calls).to eq(1)
        end

        it 'returns fallback result when fallback is provided' do
          allow(Time).to receive(:now).and_return(Time.at(12))
          fallback = proc { :fallback }

          result = breaker.execute(fallback: fallback) dook
          end

          expect(result).to eq(:fallback)
          expect(breaker.metrics.rejected_calls).to eq(1)
        end

        it 'transitions to half-open after timeout_seconds elapses' do
          allow(Time).to receive(:now).and_return(Time.at(25))
          expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
        end

        it 'keeps rejecting until timeout_seconds elapses' do
          allow(Time).to receive(:now).and_return(Time.at(19.9))
          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
          expect do
            breaker.execute dook
            end
          end.to raise_error(CircuitBreaker::OpenError)
        end
      end

      context 'when half-open' do
        let(:cfg) do
          CircuitBreaker::Config.new(
            failure_threshold: 1,
            success_threshold: 2,
            timeout_seconds: 10.0,
            half_open_max_calls: 2,
            sliding_window_size: 4,
            failure_rate_threshold: 1.0
          )
        end

        let(:b) { described_class.new('halfopen-svc', config: cfg) }

        before do
          allow(Time).to receive(:now).and_return(Time.at(1), Time.at(1.001))
          begin
            b.execute do
              raise 'open it'
            end
          rescue StandardError
          end
          expect(b.state).to eq(CircuitBreaker::State::OPEN)
          allow(Time).to receive(:now).and_return(Time.at(12))
          expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)
        end

        it 'allows up to half_open_max_calls calls and rejects additional calls' do
          allow(Time).to receive(:now).and_return(Time.at(12), Time.at(12.01))
          expect(b.execute { :ok1 }).to eq(:ok1)

          allow(Time).to receive(:now).and_return(Time.at(13), Time.at(13.01))
          expect(b.execute { :ok2 }).to eq(:ok2)

          allow(Time).to receive(:now).and_return(Time.at(14))
          expect do
            b.execute { :ok3 }
          end.to raise_error(CircuitBreaker::OpenError)

          expect(b.metrics.rejected_calls).to eq(1)
        end

        it 'closes after success_threshold successes in half-open' do
          allow(Time).to receive(:now).and_return(Time.at(12), Time.at(12.01))
          b.execute { :ok1 }
          expect(b.state).to eq(CircuitBreaker::State::HALF_OPEN)

          allow(Time).to receive(:now).and_return(Time.at(13), Time.at(13.01))
          b.execute { :ok2 }
          expect(b.state).to eq(CircuitBreaker::State::CLOSED)

          info = b.health_info
          expect(info[:failure_count]).to eq(0)
          expect(info[:success_count]).to eq(0)
        end

        it 're-opens immediately on a failure in half-open' do
          allow(Time).to receive(:now).and_return(Time.at(12), Time.at(12.01))
          expect do
            b.execute do
              raise 'nope'
            end
          end.to raise_error(RuntimeError, 'nope')

          expect(b.state).to eq(CircuitBreaker::State::OPEN)
        end
      end
    end

    describe '#state' do
      it 'returns current state' do
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end
    end

    describe '#health_info' do
      it 'returns a structured hash including metrics and config' do
        allow(Time).to receive(:now).and_return(Time.at(1), Time.at(1.01))
        breaker.execute { :ok }

        info = breaker.health_info
        expect(info[:name]).to eq('svc')
        expect(info[:state]).to eq('CLOSED')
        expect(info[:failure_count]).to be_a(Integer)
        expect(info[:success_count]).to be_a(Integer)
        expect(info[:failure_rate]).to be_a(Float)
        expect(info[:metrics]).to be_a(Hash)
        expect(info[:config]).to include(:failure_threshold, :success_threshold, :timeout_seconds)
      end
    end
  end

  describe CircuitBreaker::DistributedCoordinator do
    let(:url) { 'http://coordinator.local:8080' }
    let(:coordinator) { described_class.new(url, sync_interval: 0.01) }
    let(:breaker_config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 2,
        timeout_seconds: 0.1,
        half_open_max_calls: 1,
        sliding_window_size: 2,
        failure_rate_threshold: 1.0
      )
    end
    let(:breaker) { CircuitBreaker::Breaker.new('svc-a', config: breaker_config) }

    describe '#register' do
      it 'stores breaker and sends registration via Net::HTTP' do
        uri = URI("#{url}/circuit-breakers/register")
        http = instance_double(Net::HTTP)
        response = instance_double(Net::HTTPResponse, body: '{"ok":true}')

        allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        expect(http).to receive(:request).and_return(response)

        coordinator.register(breaker)

        breakers_hash = coordinator.instance_variable_get(:@breakers)
        expect(breakers_hash.keys).to include('svc-a')
      end

      it 'swallows Net::HTTP errors during registration' do
        uri = URI("#{url}/circuit-breakers/register")
        http = instance_double(Net::HTTP)

        allow(Net::HTTP).to receive(:new).with(uri.host, uri.port).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_raise(StandardError.new('network down'))

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end
    end

    describe '#start_sync and #stop_sync' do
      it 'starts a sync thread and stops it' do
        allow(coordinator).to receive(:sleep)
        allow(coordinator).to receive(:synchronize_states)

        coordinator.start_sync
        thread = coordinator.instance_variable_get(:@sync_thread)
        expect(thread).to be_a(Thread)

        coordinator.stop_sync
        expect(coordinator.instance_variable_get(:@running)).to eq(false)
      end
    end

    describe '#get_cluster_state' do
      it 'returns parsed JSON from coordinator' do
        service_name = 'svc-a'
        uri = URI("#{url}/circuit-breakers/#{service_name}/aggregate")
        response = instance_double(Net::HTTPResponse, body: '{"state":"CLOSED"}')

        allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)

        data = coordinator.get_cluster_state(service_name)
        expect(data).to eq({ 'state' => 'CLOSED' })
      end

      it 'returns error hash when request fails' do
        service_name = 'svc-a'
        uri = URI("#{url}/circuit-breakers/#{service_name}/aggregate")
        allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('timeout'))

        data = coordinator.get_cluster_state(service_name)
        expect(data).to eq({ error: 'timeout' })
      end
    end

    describe 'state synchronization reporting' do
      it 'reports state for each registered breaker via Net::HTTP without raising' do
        register_uri = URI("#{url}/circuit-breakers/register")
        state_uri = URI("#{url}/circuit-breakers/state")

        http_register = instance_double(Net::HTTP)
        http_state = instance_double(Net::HTTP)
        response = instance_double(Net::HTTPResponse, body: '{}')

        allow(Net::HTTP).to receive(:new).with(register_uri.host, register_uri.port).and_return(http_register)
        allow(http_register).to receive(:use_ssl=)
        allow(http_register).to receive(:open_timeout=)
        allow(http_register).to receive(:read_timeout=)
        allow(http_register).to receive(:request).and_return(response)

        allow(Net::HTTP).to receive(:new).with(state_uri.host, state_uri.port).and_return(http_state)
        allow(http_state).to receive(:use_ssl=)
        allow(http_state).to receive(:open_timeout=)
        allow(http_state).to receive(:read_timeout=)
        allow(http_state).to receive(:request).and_return(response)

        coordinator.register(breaker)

        expect do
          coordinator.send(:synchronize_states)
        end.not_to raise_error
      end

      it 'swallows errors while reporting state' do
        register_uri = URI("#{url}/circuit-breakers/register")
        state_uri = URI("#{url}/circuit-breakers/state")

        http_register = instance_double(Net::HTTP)
        http_state = instance_double(Net::HTTP)

        allow(Net::HTTP).to receive(:new).with(register_uri.host, register_uri.port).and_return(http_register)
        allow(http_register).to receive(:use_ssl=)
        allow(http_register).to receive(:open_timeout=)
        allow(http_register).to receive(:read_timeout=)
        allow(http_register).to receive(:request).and_return(instance_double(Net::HTTPResponse, body: '{}'))

        allow(Net::HTTP).to receive(:new).with(state_uri.host, state_uri.port).and_return(http_state)
        allow(http_state).to receive(:use_ssl=)
        allow(http_state).to receive(:open_timeout=)
        allow(http_state).to receive(:read_timeout=)
        allow(http_state).to receive(:request).and_raise(StandardError.new('report failed'))

        coordinator.register(breaker)

        expect do
          coordinator.send(:synchronize_states)
        end.not_to raise_error
      end
    end
  end
end
