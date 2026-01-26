# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpsg9yrn99.rb:446: syntax error, unexpected `end', expecting ')' (SyntaxError)
        end).to eq(:ok1)
        ^~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker do
  describe CircuitBreaker::OpenError do
    describe '#initialize' do
      let(:name) { 'payments' }
      let(:remaining_time) { 1.2345 }
      let(:error) { described_class.new(name, remaining_time) }

      it 'stores the name and remaining_time' do
        expect(error.name).to eq(name)
        expect(error.remaining_time).to eq(remaining_time)
      end

      it 'includes details in the message' do
        expect(error.message).to include("Circuit breaker '#{name}' is open")
        expect(error.message).to include('Retry after')
      end
    end
  end

  describe CircuitBreaker::State do
    describe '.all' do
      it 'returns all possible states' do
        expect(described_class.all).to contain_exactly(:closed, :open, :half_open)
      end
    end
  end

  describe CircuitBreaker::Config do
    describe '#initialize' do
      it 'provides sensible defaults' do
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
      it 'increments counts and sets last_success_time' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        expect(metrics.total_calls).to eq(0)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.last_success_time).to be_nil

        metrics.record_success(0.05)

        expect(metrics.total_calls).to eq(1)
        expect(metrics.successful_calls).to eq(1)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.last_success_time).to eq(now)
      end
    end

    describe '#record_failure' do
      it 'increments counts and sets last_failure_time' do
        now = Time.utc(2020, 1, 1, 0, 0, 1)
        allow(Time).to receive(:now).and_return(now)

        expect(metrics.total_calls).to eq(0)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.last_failure_time).to be_nil

        metrics.record_failure(0.07)

        expect(metrics.total_calls).to eq(1)
        expect(metrics.failed_calls).to eq(1)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.last_failure_time).to eq(now)
      end
    end

    describe '#record_rejection' do
      it 'increments rejected_calls without affecting total_calls' do
        metrics.record_rejection
        metrics.record_rejection

        expect(metrics.rejected_calls).to eq(2)
        expect(metrics.total_calls).to eq(0)
      end
    end

    describe '#record_state_transition' do
      it 'increments state_transitions' do
        expect(metrics.state_transitions).to eq(0)

        metrics.record_state_transition
        metrics.record_state_transition

        expect(metrics.state_transitions).to eq(2)
      end
    end

    describe '#average_response_time' do
      it 'returns 0 when there are no response times' do
        expect(metrics.average_response_time).to eq(0)
      end

      it 'returns the mean duration for recorded calls' do
        metrics.record_success(0.10)
        metrics.record_failure(0.30)

        expect(metrics.average_response_time).to be_within(0.000001).of(0.20)
      end

      it 'caps stored response times to the internal max (100)' do
        101.times do
          metrics.record_success(0.001)
        end

        expect(metrics.total_calls).to eq(101)
        expect(metrics.average_response_time).to be_within(0.000001).of(0.001)
      end
    end

    describe '#to_h' do
      it 'returns a hash with expected keys and ISO8601 timestamps when present' do
        t1 = Time.utc(2020, 1, 1, 0, 0, 0)
        t2 = Time.utc(2020, 1, 1, 0, 0, 2)

        allow(Time).to receive(:now).and_return(t1)
        metrics.record_failure(0.1)

        allow(Time).to receive(:now).and_return(t2)
        metrics.record_success(0.3)

        hash = nil
        expect do
          hash = metrics.to_h
        end.not_to raise_error

        expect(hash).to be_a(Hash)
        expect(hash[:total_calls]).to eq(2)
        expect(hash[:failed_calls]).to eq(1)
        expect(hash[:successful_calls]).to eq(1)
        expect(hash[:rejected_calls]).to eq(0)
        expect(hash[:state_transitions]).to eq(0)
        expect(hash[:average_response_time_ms]).to be_a(Numeric)
        expect(hash[:last_failure_time]).to eq(t1.iso8601)
        expect(hash[:last_success_time]).to eq(t2.iso8601)
      end

      it 'returns nil timestamps when no calls have been recorded' do
        hash = metrics.to_h
        expect(hash[:last_failure_time]).to be_nil
        expect(hash[:last_success_time]).to be_nil
        expect(hash[:average_response_time_ms]).to eq(0)
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

    let(:breaker) { described_class.new('service-a', config: config) }

    describe '.get_or_create' do
      let(:unique_name) { "svc-#{Time.now.to_f}-#{rand(1_000_000)}" }

      it 'returns the same instance for the same name' do
        first = described_class.get_or_create(unique_name, config: config)
        second = described_class.get_or_create(unique_name, config: CircuitBreaker::Config.new(failure_threshold: 99))

        expect(first).to be_a(described_class)
        expect(second).to equal(first)
      end
    end

    describe '.registry' do
      let(:unique_name) { "reg-#{Time.now.to_f}-#{rand(1_000_000)}" }

      it 'returns a duplicate of the internal registry hash' do
        described_class.get_or_create(unique_name, config: config)
        copy = described_class.registry

        expect(copy).to be_a(Hash)
        expect(copy[unique_name]).to be_a(described_class)

        copy.delete(unique_name)
        expect(described_class.registry[unique_name]).to be_a(described_class)
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

      context 'when the circuit is closed' do
        it 'returns the block result and records a success' do
          result = breaker.execute do
            123
          end

          expect(result).to eq(123)
          expect(breaker.metrics.total_calls).to eq(1)
          expect(breaker.metrics.successful_calls).to eq(1)
          expect(breaker.metrics.failed_calls).to eq(0)
        end

        it 're-raises errors from the block and records a failure' do
          expect do
            breaker.execute do
              raise StandardError, 'boom'
            end
          end.to raise_error(StandardError, 'boom')

          expect(breaker.metrics.total_calls).to eq(1)
          expect(breaker.metrics.failed_calls).to eq(1)
          expect(breaker.metrics.successful_calls).to eq(0)
        end

        it 'can open due to failure_threshold and then reject subsequent calls' do
          expect do
            breaker.execute do
              raise StandardError, 'fail-1'
            end
          end.to raise_error(StandardError)

          expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)

          expect do
            breaker.execute do
              raise StandardError, 'fail-2'
            end
          end.to raise_error(StandardError)

          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

          expect do
            breaker.execute do
              1
            end
          end.to raise_error(CircuitBreaker::OpenError)

          expect(breaker.metrics.rejected_calls).to eq(1)
        end

        it 'can open due to failure_rate_threshold even if failure_count is below failure_threshold' do
          local_config = CircuitBreaker::Config.new(
            failure_threshold: 10,
            success_threshold: 1,
            timeout_seconds: 10.0,
            half_open_max_calls: 1,
            sliding_window_size: 2,
            failure_rate_threshold: 0.5
          )
          local_breaker = described_class.new('service-rate', config: local_config)

          expect do
            local_breaker.execute do
              raise StandardError, 'rate-fail'
            end
          end.to raise_error(StandardError)

          expect(local_breaker.state).to eq(CircuitBreaker::State::OPEN)
        end
      end

      context 'when the circuit is open' do
        let(:now) { Time.utc(2020, 1, 1, 0, 0, 0) }

        before do
          allow(Time).to receive(:now).and_return(now)
          2.times do
            begin
              breaker.execute do
                raise StandardError, 'boom'
              end
            rescue StandardError
            end
          end
          expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
        end

        it 'raises OpenError with remaining_time when no fallback is provided' do
          allow(Time).to receive(:now).and_return(now + 3)

          expect do
            breaker.execute do
              1
            end
          end.to raise_error(CircuitBreaker::OpenError) do |e|
            expect(e.name).to eq('service-a')
            expect(e.remaining_time).to be_within(0.0001).of(7.0)
          end
        end

        it 'returns fallback value and records a rejection when fallback is provided' do
          allow(Time).to receive(:now).and_return(now + 3)
          fallback = proc { :fallback_value }

          result = breaker.execute(fallback: fallback) do
            1
          end

          expect(result).to eq(:fallback_value)
          expect(breaker.metrics.rejected_calls).to eq(1)
        end
      end
    end

    describe '#state' do
      it 'returns CLOSED initially' do
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'transitions from OPEN to HALF_OPEN after timeout has elapsed' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        2.times do
          begin
            breaker.execute do
              raise StandardError, 'boom'
            end
          rescue StandardError
          end
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_return(now + 11)

        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      end

      it 'enforces half_open_max_calls during HALF_OPEN by rejecting additional calls' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        2.times do
          begin
            breaker.execute do
              raise StandardError, 'boom'
            end
          rescue StandardError
          end
        end

        allow(Time).to receive(:now).and_return(now + 11)
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute dook1
          end
        end.not_to raise_error

        expect do
          breaker.execute dook2
          end
        end.not_to raise_error

        expect do
          breaker.execute dook3
          end
        end.to raise_error(CircuitBreaker::OpenError)

        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'transitions back to OPEN on a failure during HALF_OPEN' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        2.times do
          begin
            breaker.execute do
              raise StandardError, 'boom'
            end
          rescue StandardError
          end
        end

        allow(Time).to receive(:now).and_return(now + 11)
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute do
            raise StandardError, 'half-open-fail'
          end
        end.to raise_error(StandardError, 'half-open-fail')

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'transitions to CLOSED after enough successes during HALF_OPEN' do
        now = Time.utc(2020, 1, 1, 0, 0, 0)
        allow(Time).to receive(:now).and_return(now)

        2.times do
          begin
            breaker.execute do
              raise StandardError, 'boom'
            end
          rescue StandardError
          end
        end

        allow(Time).to receive(:now).and_return(now + 11)
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect(breaker.execute dook1
        end).to eq(:ok1)

        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect(breaker.execute dook2
        end).to eq(:ok2)

        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end
    end

    describe '#health_info' do
      it 'returns a structured hash including metrics and config' do
        begin
          breaker.execute do
            raise StandardError, 'boom'
          end
        rescue StandardError
        end

        info = breaker.health_info
        expect(info).to be_a(Hash)
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

  describe CircuitBreaker::DistributedCoordinator do
    let(:coordinator_url) { 'http://coordinator.test' }
    let(:coordinator) { described_class.new(coordinator_url, sync_interval: 0.01) }
    let(:breaker_config) { CircuitBreaker::Config.new(failure_threshold: 1, success_threshold: 1) }
    let(:breaker) { CircuitBreaker::Breaker.new('svc-x', config: breaker_config) }

    describe '#register' do
      it 'stores the breaker and attempts to send registration, swallowing errors' do
        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_raise(StandardError, 'network down')

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end

      it 'sends a registration request with JSON body' do
        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)

        captured_request = nil
        allow(http).to receive(:request) do |req|
          captured_request = req
          instance_double(Net::HTTPResponse, body: '{}')
        end

        coordinator.register(breaker)

        expect(captured_request).to be_a(Net::HTTP::Post)
        expect(captured_request['Content-Type']).to eq('application/json')

        body = JSON.parse(captured_request.body)
        expect(body['service']).to eq('svc-x')
        expect(body).to include('node_id')
        expect(body['failure_threshold']).to eq(breaker_config.failure_threshold)
        expect(body['success_threshold']).to eq(breaker_config.success_threshold)
      end
    end

    describe '#start_sync and #stop_sync' do
      it 'starts a background thread and stops it cleanly' do
        allow(coordinator).to receive(:sleep)

        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_return(instance_double(Net::HTTPResponse, body: '{}'))

        coordinator.register(breaker)

        expect do
          coordinator.start_sync
        end.not_to raise_error

        expect do
          coordinator.stop_sync
        end.not_to raise_error
      end
    end

    describe '#get_cluster_state' do
      it 'returns parsed JSON on success' do
        uri = URI("#{coordinator_url}/circuit-breakers/svc-x/aggregate")
        response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
        allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)

        result = coordinator.get_cluster_state('svc-x')
        expect(result).to eq({ 'ok' => true })
      end

      it 'returns an error hash when Net::HTTP raises' do
        uri = URI("#{coordinator_url}/circuit-breakers/svc-x/aggregate")
        allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError, 'timeout')

        result = coordinator.get_cluster_state('svc-x')
        expect(result).to eq({ error: 'timeout' })
      end
    end
  end
end
