# WARNING: This test file may contain syntax errors
# Generated after 3 attempts with validation errors
# Last error: ruby: /tmp/tmpxj429mxk.rb:279: syntax error, unexpected local variable or method, expecting `end' or dummy end (SyntaxError)
...ck: -> { :fallback }) doprimary
...                      ^~~~~~~~~
/tmp/tmpxj429mxk.rb:312: syntax error, unexpected `end'
        end.not_to raise_error
        ^~~
# Please review and fix any issues before running

require 'spec_helper'
require_relative '../app/circuit_breaker'

RSpec.describe CircuitBreaker do
  describe CircuitBreaker::OpenError do
    describe '#initialize' do
      it 'stores name and remaining_time and builds a message' do
        error = described_class.new('svc', 1.23456)

        expect(error.name).to eq('svc')
        expect(error.remaining_time).to eq(1.23456)
        expect(error.message).to include("Circuit breaker 'svc' is open")
        expect(error.message).to include('Retry after')
      end
    end
  end

  describe CircuitBreaker::State do
    describe '.all' do
      it 'returns all states' do
        expect(described_class.all).to contain_exactly(
          CircuitBreaker::State::CLOSED,
          CircuitBreaker::State::OPEN,
          CircuitBreaker::State::HALF_OPEN
        )
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
          half_open_max_calls: 9,
          sliding_window_size: 4,
          failure_rate_threshold: 0.75
        )

        expect(config.failure_threshold).to eq(2)
        expect(config.success_threshold).to eq(1)
        expect(config.timeout_seconds).to eq(0.25)
        expect(config.half_open_max_calls).to eq(9)
        expect(config.sliding_window_size).to eq(4)
        expect(config.failure_rate_threshold).to eq(0.75)
      end
    end
  end

  describe CircuitBreaker::Metrics do
    let(:metrics) { described_class.new }

    describe '#record_success' do
      it 'increments successful_calls and total_calls and sets last_success_time' do
        fixed_time = Time.at(1000)
        allow(Time).to receive(:now).and_return(fixed_time)

        expect do
          metrics.record_success(0.01)
        end.not_to raise_error

        expect(metrics.total_calls).to eq(1)
        expect(metrics.successful_calls).to eq(1)
        expect(metrics.failed_calls).to eq(0)
        expect(metrics.last_success_time).to eq(fixed_time)
      end
    end

    describe '#record_failure' do
      it 'increments failed_calls and total_calls and sets last_failure_time' do
        fixed_time = Time.at(2000)
        allow(Time).to receive(:now).and_return(fixed_time)

        expect do
          metrics.record_failure(0.02)
        end.not_to raise_error

        expect(metrics.total_calls).to eq(1)
        expect(metrics.failed_calls).to eq(1)
        expect(metrics.successful_calls).to eq(0)
        expect(metrics.last_failure_time).to eq(fixed_time)
      end
    end

    describe '#record_rejection' do
      it 'increments rejected_calls without affecting total_calls' do
        expect do
          metrics.record_rejection
        end.not_to raise_error

        expect(metrics.rejected_calls).to eq(1)
        expect(metrics.total_calls).to eq(0)
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
      it 'returns 0 when no response times recorded' do
        expect(metrics.average_response_time).to eq(0)
      end

      it 'returns the average of recorded response times' do
        metrics.record_success(0.1)
        metrics.record_failure(0.3)

        expect(metrics.average_response_time).to be_within(0.000001).of(0.2)
      end

      it 'caps the internal response time storage at 100 samples' do
        101.times do |i|
          metrics.record_success(i.to_f)
        end

        expect(metrics.average_response_time).to be_within(0.000001).of(50.5)
      end
    end

    describe '#to_h' do
      it 'returns a hash with expected keys and ISO8601 timestamps when present' do
        t1 = Time.at(3000)
        t2 = Time.at(4000)

        allow(Time).to receive(:now).and_return(t1)
        metrics.record_failure(0.2)

        allow(Time).to receive(:now).and_return(t2)
        metrics.record_success(0.4)

        result = nil
        expect do
          result = metrics.to_h
        end.not_to raise_error

        expect(result[:total_calls]).to eq(2)
        expect(result[:successful_calls]).to eq(1)
        expect(result[:failed_calls]).to eq(1)
        expect(result[:rejected_calls]).to eq(0)
        expect(result[:state_transitions]).to eq(0)
        expect(result[:average_response_time_ms]).to eq(300.0)
        expect(result[:last_failure_time]).to eq(t1.iso8601)
        expect(result[:last_success_time]).to eq(t2.iso8601)
      end

      it 'returns nil timestamps when none recorded' do
        result = metrics.to_h

        expect(result[:last_failure_time]).to be_nil
        expect(result[:last_success_time]).to be_nil
      end
    end
  end

  describe CircuitBreaker::Breaker do
    let(:config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 2,
        timeout_seconds: 0.5,
        half_open_max_calls: 2,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
    end

    let(:breaker) { described_class.new('svc', config: config) }

    describe '.get_or_create' do
      it 'returns the same instance for the same name' do
        b1 = described_class.get_or_create('shared')
        b2 = described_class.get_or_create('shared')

        expect(b1.object_id).to eq(b2.object_id)
      end

      it 'stores created instances in the registry' do
        b = described_class.get_or_create('registry-test')

        expect(described_class.registry['registry-test']).to eq(b)
      end
    end

    describe '.registry' do
      it 'returns a duplicate hash, not the internal registry object' do
        described_class.get_or_create('dup-test')
        r1 = described_class.registry
        r2 = described_class.registry

        expect(r1).to be_a(Hash)
        expect(r2).to be_a(Hash)
        expect(r1.object_id).not_to eq(r2.object_id)

        r1['mutate'] = :x
        expect(described_class.registry.key?('mutate')).to eq(false)
      end
    end

    describe '#execute' do
      it 'raises ArgumentError when no block given' do
        expect do
          breaker.execute
        end.to raise_error(ArgumentError, 'Block required')
      end

      it 'returns the block result on success and remains closed initially' do
        result = breaker.execute do
          123
        end

        expect(result).to eq(123)
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.metrics.successful_calls).to eq(1)
      end

      it 'records failures and re-raises the original error' do
        expect do
          breaker.execute do
            raise 'boom'
          end
        end.to raise_error(RuntimeError, 'boom')

        expect(breaker.metrics.total_calls).to eq(1)
        expect(breaker.metrics.failed_calls).to eq(1)
      end

      it 'opens after reaching failure_threshold and then raises OpenError on further calls' do
        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        expect do
          breaker.execute do
            1
          end
        end.to raise_error(CircuitBreaker::OpenError)

        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'returns fallback result when open and fallback provided' do
        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        result = breaker.execute(fallback: -> { :fallback }) doprimary
        end

        expect(result).to eq(:fallback)
        expect(breaker.metrics.rejected_calls).to eq(1)
      end

      it 'limits calls in HALF_OPEN based on half_open_max_calls' do
        start = Time.at(10_000)
        allow(Time).to receive(:now).and_return(start)

        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_return(start + 1.0)

        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute dook1
          end
        end.not_to raise_error

        expect do
          breaker.execute dook2
          end
        end.not_to raise_error

        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute dook3
          end
        end.to raise_error(CircuitBreaker::OpenError)
      end

      it 'transitions from HALF_OPEN to CLOSED after success_threshold successes' do
        start = Time.at(20_000)
        allow(Time).to receive(:now).and_return(start)

        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_return(start + 1.0)
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        breaker.execute dook1
        end

        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        breaker.execute dook2
        end

        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'transitions from HALF_OPEN back to OPEN on first failure' do
        start = Time.at(30_000)
        allow(Time).to receive(:now).and_return(start)

        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        allow(Time).to receive(:now).and_return(start + 1.0)
        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)

        expect do
          breaker.execute do
            raise 'nope'
          end
        end.to raise_error(RuntimeError, 'nope')

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)
      end

      it 'opens based on failure_rate_threshold even if failure_threshold not reached' do
        rate_config = CircuitBreaker::Config.new(
          failure_threshold: 10,
          success_threshold: 1,
          timeout_seconds: 1.0,
          half_open_max_calls: 1,
          sliding_window_size: 4,
          failure_rate_threshold: 0.5
        )
        b = described_class.new('rate', config: rate_config)

        b.execute dook
        end

        2.times do
          expect do
            b.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        expect(b.state).to eq(CircuitBreaker::State::OPEN)
      end
    end

    describe '#state' do
      it 'returns CLOSED initially' do
        expect(breaker.state).to eq(CircuitBreaker::State::CLOSED)
      end

      it 'moves from OPEN to HALF_OPEN after timeout_seconds elapse' do
        start = Time.at(40_000)
        allow(Time).to receive(:now).and_return(start)

        2.times do
          expect do
            breaker.execute do
              raise 'fail'
            end
          end.to raise_error(RuntimeError, 'fail')
        end

        expect(breaker.state).to eq(CircuitBreaker::State::OPEN)

        allow(Time).to receive(:now).and_return(start + config.timeout_seconds + 0.001)

        expect(breaker.state).to eq(CircuitBreaker::State::HALF_OPEN)
      end
    end

    describe '#health_info' do
      it 'returns a structured hash with state, counters, metrics and config subset' do
        breaker.execute dook
        end

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
    let(:coordinator_url) { 'http://coordinator.test:1234' }
    let(:sync_interval) { 0.01 }
    let(:coordinator) { described_class.new(coordinator_url, sync_interval: sync_interval) }

    let(:breaker_config) do
      CircuitBreaker::Config.new(
        failure_threshold: 2,
        success_threshold: 2,
        timeout_seconds: 0.5,
        half_open_max_calls: 1,
        sliding_window_size: 4,
        failure_rate_threshold: 0.5
      )
    end

    let(:breaker) { CircuitBreaker::Breaker.new('svc', config: breaker_config) }

    def stub_net_http_new_and_request
      response = instance_double(Net::HTTPResponse, body: '{"ok":true}')
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(response)
      [http, response]
    end

    describe '#register' do
      it 'stores breaker and attempts registration via HTTP' do
        http, _response = stub_net_http_new_and_request

        expect do
          coordinator.register(breaker)
        end.not_to raise_error

        expect(Net::HTTP).to have_received(:new)
        expect(http).to have_received(:open_timeout=).with(5)
        expect(http).to have_received(:read_timeout=).with(5)
        expect(http).to have_received(:request)
      end

      it 'swallows HTTP errors during registration' do
        http = instance_double(Net::HTTP)
        allow(Net::HTTP).to receive(:new).and_return(http)
        allow(http).to receive(:use_ssl=)
        allow(http).to receive(:open_timeout=)
        allow(http).to receive(:read_timeout=)
        allow(http).to receive(:request).and_raise(StandardError.new('net down'))

        expect do
          coordinator.register(breaker)
        end.not_to raise_error
      end
    end

    describe '#start_sync and #stop_sync' do
      it 'starts a sync thread and stops it' do
        stub_net_http_new_and_request
        coordinator.register(breaker)

        allow(coordinator).to receive(:sleep).and_return(nil)

        expect do
          coordinator.start_sync
          coordinator.stop_sync
        end.not_to raise_error
      end
    end

    describe '#get_cluster_state' do
      it 'returns parsed JSON on success' do
        uri = URI("#{coordinator_url}/circuit-breakers/svc/aggregate")
        response = instance_double(Net::HTTPResponse, body: '{"state":"OK"}')

        allow(Net::HTTP).to receive(:get_response).with(uri).and_return(response)

        result = coordinator.get_cluster_state('svc')
        expect(result).to eq({ 'state' => 'OK' })
      end

      it 'returns an error hash when request fails' do
        uri = URI("#{coordinator_url}/circuit-breakers/svc/aggregate")
        allow(Net::HTTP).to receive(:get_response).with(uri).and_raise(StandardError.new('boom'))

        result = coordinator.get_cluster_state('svc')
        expect(result).to eq({ error: 'boom' })
      end
    end
  end
end
