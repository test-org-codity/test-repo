# frozen_string_literal: true

require 'json'
require 'net/http'
require 'uri'
require 'thread'
require 'monitor'

module CircuitBreaker
  class Error < StandardError; end
  class OpenError < Error
    attr_reader :name, :remaining_time

    def initialize(name, remaining_time)
      @name = name
      @remaining_time = remaining_time
      super("Circuit breaker '#{name}' is open. Retry after #{remaining_time.round(2)}s")
    end
  end

  class State
    CLOSED = :closed
    OPEN = :open
    HALF_OPEN = :half_open

    def self.all
      [CLOSED, OPEN, HALF_OPEN]
    end
  end

  class Config
    attr_accessor :failure_threshold, :success_threshold, :timeout_seconds,
                  :half_open_max_calls, :sliding_window_size, :failure_rate_threshold

    def initialize(
      failure_threshold: 5,
      success_threshold: 3,
      timeout_seconds: 30.0,
      half_open_max_calls: 3,
      sliding_window_size: 10,
      failure_rate_threshold: 0.5
    )
      @failure_threshold = failure_threshold
      @success_threshold = success_threshold
      @timeout_seconds = timeout_seconds
      @half_open_max_calls = half_open_max_calls
      @sliding_window_size = sliding_window_size
      @failure_rate_threshold = failure_rate_threshold
    end
  end

  class Metrics
    attr_reader :total_calls, :successful_calls, :failed_calls, :rejected_calls,
                :state_transitions, :last_failure_time, :last_success_time

    def initialize
      @total_calls = 0
      @successful_calls = 0
      @failed_calls = 0
      @rejected_calls = 0
      @state_transitions = 0
      @last_failure_time = nil
      @last_success_time = nil
      @response_times = []
      @max_response_times = 100
      @mutex = Mutex.new
    end

    def record_success(duration)
      @mutex.synchronize do
        @successful_calls += 1
        @total_calls += 1
        @last_success_time = Time.now
        add_response_time(duration)
      end
    end

    def record_failure(duration)
      @mutex.synchronize do
        @failed_calls += 1
        @total_calls += 1
        @last_failure_time = Time.now
        add_response_time(duration)
      end
    end

    def record_rejection
      @mutex.synchronize { @rejected_calls += 1 }
    end

    def record_state_transition
      @mutex.synchronize { @state_transitions += 1 }
    end

    def average_response_time
      @mutex.synchronize do
        return 0 if @response_times.empty?
        @response_times.sum / @response_times.size
      end
    end

    def to_h
      @mutex.synchronize do
        {
          total_calls: @total_calls,
          successful_calls: @successful_calls,
          failed_calls: @failed_calls,
          rejected_calls: @rejected_calls,
          state_transitions: @state_transitions,
          average_response_time_ms: (average_response_time * 1000).round(2),
          last_failure_time: @last_failure_time&.iso8601,
          last_success_time: @last_success_time&.iso8601
        }
      end
    end

    private

    def add_response_time(duration)
      @response_times << duration
      @response_times.shift if @response_times.size > @max_response_times
    end
  end

  class Breaker
    include MonitorMixin

    attr_reader :name, :config, :metrics

    @@registry = {}
    @@registry_mutex = Mutex.new

    def self.get_or_create(name, config: nil)
      @@registry_mutex.synchronize do
        @@registry[name] ||= new(name, config: config)
      end
    end

    def self.registry
      @@registry_mutex.synchronize { @@registry.dup }
    end

    def initialize(name, config: nil)
      super()
      @name = name
      @config = config || Config.new
      @state = State::CLOSED
      @failure_count = 0
      @success_count = 0
      @half_open_calls = 0
      @opened_at = nil
      @metrics = Metrics.new
      @sliding_window = Array.new(@config.sliding_window_size, true)
      @window_index = 0
    end

    def execute(fallback: nil, &block)
      raise ArgumentError, 'Block required' unless block_given?

      unless allow_request?
        @metrics.record_rejection
        return fallback.call if fallback
        remaining = @config.timeout_seconds - (Time.now - (@opened_at || Time.now))
        raise OpenError.new(@name, [remaining, 0].max)
      end

      start_time = Time.now
      begin
        result = yield
        duration = Time.now - start_time
        record_success(duration)
        result
      rescue StandardError => e
        duration = Time.now - start_time
        record_failure(duration)
        raise
      end
    end

    def state
      synchronize do
        if @state == State::OPEN && should_attempt_reset?
          transition_to(State::HALF_OPEN)
        end
        @state
      end
    end

    def health_info
      synchronize do
        {
          name: @name,
          state: @state.to_s.upcase,
          failure_count: @failure_count,
          success_count: @success_count,
          failure_rate: calculate_failure_rate,
          metrics: @metrics.to_h,
          config: {
            failure_threshold: @config.failure_threshold,
            success_threshold: @config.success_threshold,
            timeout_seconds: @config.timeout_seconds
          }
        }
      end
    end

    private

    def allow_request?
      synchronize do
        current_state = state

        case current_state
        when State::CLOSED
          true
        when State::OPEN
          false
        when State::HALF_OPEN
          if @half_open_calls < @config.half_open_max_calls
            @half_open_calls += 1
            true
          else
            false
          end
        else
          false
        end
      end
    end

    def should_attempt_reset?
      return false unless @opened_at
      Time.now - @opened_at >= @config.timeout_seconds
    end

    def transition_to(new_state)
      old_state = @state
      return if old_state == new_state

      @state = new_state
      @metrics.record_state_transition

      case new_state
      when State::OPEN
        @opened_at = Time.now
      when State::HALF_OPEN
        @half_open_calls = 0
        @success_count = 0
      when State::CLOSED
        @failure_count = 0
        @success_count = 0
        @opened_at = nil
        @sliding_window.fill(true)
        @window_index = 0
      end
    end

    def record_success(duration)
      synchronize do
        @metrics.record_success(duration)
        add_to_sliding_window(true)

        case @state
        when State::HALF_OPEN
          @success_count += 1
          transition_to(State::CLOSED) if @success_count >= @config.success_threshold
        when State::CLOSED
          @failure_count = [@failure_count - 1, 0].max
        end
      end
    end

    def record_failure(duration)
      synchronize do
        @metrics.record_failure(duration)
        add_to_sliding_window(false)

        case @state
        when State::HALF_OPEN
          transition_to(State::OPEN)
        when State::CLOSED
          @failure_count += 1
          failure_rate = calculate_failure_rate

          if @failure_count >= @config.failure_threshold ||
             failure_rate >= @config.failure_rate_threshold
            transition_to(State::OPEN)
          end
        end
      end
    end

    def add_to_sliding_window(success)
      @sliding_window[@window_index] = success
      @window_index = (@window_index + 1) % @config.sliding_window_size
    end

    def calculate_failure_rate
      failures = @sliding_window.count(false)
      failures.to_f / @sliding_window.size
    end
  end

  class DistributedCoordinator
    def initialize(coordinator_url, sync_interval: 5.0)
      @coordinator_url = coordinator_url
      @sync_interval = sync_interval
      @node_id = ENV['NODE_ID'] || "ruby-#{Process.pid}"
      @breakers = {}
      @running = false
      @sync_thread = nil
      @mutex = Mutex.new
    end

    def register(breaker)
      @mutex.synchronize { @breakers[breaker.name] = breaker }
      send_registration(breaker)
    end

    def start_sync
      @running = true
      @sync_thread = Thread.new do
        while @running
          sleep @sync_interval
          synchronize_states
        end
      end
    end

    def stop_sync
      @running = false
      @sync_thread&.join(2)
    end

    def get_cluster_state(service_name)
      uri = URI("#{@coordinator_url}/circuit-breakers/#{service_name}/aggregate")
      response = Net::HTTP.get_response(uri)
      JSON.parse(response.body)
    rescue StandardError => e
      { error: e.message }
    end

    private

    def send_registration(breaker)
      uri = URI("#{@coordinator_url}/circuit-breakers/register")
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 5
      http.read_timeout = 5

      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/json'
      request.body = {
        service: breaker.name,
        node_id: @node_id,
        failure_threshold: breaker.config.failure_threshold,
        success_threshold: breaker.config.success_threshold
      }.to_json

      http.request(request)
    rescue StandardError
    end

    def synchronize_states
      @mutex.synchronize do
        @breakers.each do |name, breaker|
          report_state(name, breaker)
        end
      end
    end

    def report_state(name, breaker)
      uri = URI("#{@coordinator_url}/circuit-breakers/state")
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 5
      http.read_timeout = 5

      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/json'
      request.body = {
        service: name,
        node_id: @node_id,
        state: breaker.state.to_s.upcase,
        timestamp: (Time.now.to_f * 1000).to_i,
        health_info: breaker.health_info
      }.to_json

      http.request(request)
    rescue StandardError
    end
  end
end
