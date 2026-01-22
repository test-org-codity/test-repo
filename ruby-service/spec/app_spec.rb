# frozen_string_literal: true

require_relative 'spec_helper'
require_relative '../app/app'

RSpec.describe PolyglotAPI do
  include Rack::Test::Methods

  def app
    PolyglotAPI
  end

  describe 'GET /health' do
    it 'returns healthy status' do
      get '/health'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['status']).to eq('healthy')
    end
  end

  describe 'POST /analyze' do
    it 'accepts valid content' do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .and_return({ 'language' => 'python', 'lines' => ['def test'] })
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .and_return({ 'score' => 85.0, 'issues' => [] })

      post '/analyze', { content: 'def test(): pass', path: 'test.py' }.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response).to have_key('summary')
    end
  end

  describe 'GET /status' do
    let(:go_url) { 'http://go-service' }
    let(:python_url) { 'http://python-service' }
    let(:cache_url) { 'http://cache-service' }

    before do
      allow(PolyglotAPI).to receive(:settings).and_return(
        double(
          go_service_url: go_url,
          python_service_url: python_url,
          cache_service_url: cache_url
        )
      )
    end

    it 'returns health status for all services when healthy' do
      allow(HTTParty).to receive(:get).with("#{go_url}/health", timeout: 2)
                                      .and_return(double(code: 200))
      allow(HTTParty).to receive(:get).with("#{python_url}/health", timeout: 2)
                                      .and_return(double(code: 200))
      allow(HTTParty).to receive(:get).with("#{cache_url}/health", timeout: 2)
                                      .and_return(double(code: 200))

      get '/status'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['services']['ruby']['status']).to eq('healthy')
      expect(json_response['services']['go']['status']).to eq('healthy')
      expect(json_response['services']['python']['status']).to eq('healthy')
      expect(json_response['services']['cache']['status']).to eq('healthy')
    end

    it 'marks service as unreachable on error' do
      allow(HTTParty).to receive(:get).with("#{go_url}/health", timeout: 2)
                                      .and_raise(StandardError.new('connection failed'))
      allow(HTTParty).to receive(:get).with("#{python_url}/health", timeout: 2)
                                      .and_return(double(code: 500))
      allow(HTTParty).to receive(:get).with("#{cache_url}/health", timeout: 2)
                                      .and_return(double(code: 200))

      get '/status'
      json_response = JSON.parse(last_response.body)
      expect(json_response['services']['go']['status']).to eq('unreachable')
      expect(json_response['services']['go']['error']).to eq('connection failed')
      expect(json_response['services']['python']['status']).to eq('unhealthy')
      expect(json_response['services']['cache']['status']).to eq('healthy')
    end
  end

  describe 'GET /cache/stats' do
    let(:cache_url) { 'http://cache-service' }

    before do
      allow(PolyglotAPI).to receive(:settings).and_return(
        double(
          cache_service_url: cache_url,
          go_service_url: 'http://go-service',
          python_service_url: 'http://python-service'
        )
      )
    end

    it 'returns cache stats on success' do
      response_body = { 'hits' => 10, 'misses' => 2 }.to_json
      allow(HTTParty).to receive(:get)
        .with("#{cache_url}/cache/stats", timeout: 3)
        .and_return(double(body: response_body))

      get '/cache/stats'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['hits']).to eq(10)
      expect(json_response['misses']).to eq(2)
    end

    it 'returns error message when request fails' do
      allow(HTTParty).to receive(:get)
        .with("#{cache_url}/cache/stats", timeout: 3)
        .and_raise(StandardError.new('timeout'))

      get '/cache/stats'
      json_response = JSON.parse(last_response.body)
      expect(json_response['error']).to eq('timeout')
    end
  end

  describe 'POST /cache/invalidate' do
    let(:cache_url) { 'http://cache-service' }

    before do
      allow(PolyglotAPI).to receive(:settings).and_return(
        double(
          cache_service_url: cache_url,
          go_service_url: 'http://go-service',
          python_service_url: 'http://python-service'
        )
      )
    end

    context 'with missing service parameter' do
      it 'returns 400 error' do
        post '/cache/invalidate', { key: 'abc' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing service parameter')
      end
    end

    context 'with valid JSON body' do
      it 'forwards request to cache service and returns response' do
        response_body = { 'status' => 'cleared' }.to_json
        expect(HTTParty).to receive(:post).with(
          "#{cache_url}/cache/invalidate",
          body: { service: 'go', key: 'file1' }.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 3
        ).and_return(double(body: response_body))

        post '/cache/invalidate', { service: 'go', key: 'file1' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('cleared')
      end
    end

    context 'with invalid JSON body' do
      it 'falls back to params and succeeds' do
        response_body = { 'status' => 'cleared' }.to_json
        expect(HTTParty).to receive(:post).with(
          "#{cache_url}/cache/invalidate",
          body: { service: 'python', key: 'k1' }.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 3
        ).and_return(double(body: response_body))

        header 'CONTENT_TYPE', 'application/json'
        post '/cache/invalidate', 'invalid-json', { service: 'python', key: 'k1' }
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('cleared')
      end
    end

    context 'when cache service request fails' do
      it 'returns error message' do
        expect(HTTParty).to receive(:post).and_raise(StandardError.new('connection refused'))

        post '/cache/invalidate', { service: 'go', key: 'file1' }.to_json, 'CONTENT_TYPE' => 'application/json'
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('connection refused')
      end
    end
  end

  describe 'POST /cache/invalidate-all' do
    let(:go_url) { 'http://go-service' }
    let(:python_url) { 'http://python-service' }
    let(:cache_url) { 'http://cache-service' }

    before do
      allow(PolyglotAPI).to receive(:settings).and_return(
        double(
          go_service_url: go_url,
          python_service_url: python_url,
          cache_service_url: cache_url
        )
      )
    end

    it 'clears cache for all services successfully' do
      expect(HTTParty).to receive(:post).with("#{go_url}/cache/clear", timeout: 3)
      expect(HTTParty).to receive(:post).with("#{python_url}/cache/clear", timeout: 3)
      expect(HTTParty).to receive(:post).with("#{cache_url}/cache/invalidate-all", timeout: 3)

      post '/cache/invalidate-all'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['message']).to eq('Cache invalidation completed')
      expect(json_response['cleared_services']).to include('go', 'python', 'cache')
    end

    it 'records failures for services that error' do
      expect(HTTParty).to receive(:post).with("#{go_url}/cache/clear", timeout: 3)
                                        .and_raise(StandardError.new('go down'))
      expect(HTTParty).to receive(:post).with("#{python_url}/cache/clear", timeout: 3)
                                        .and_return(double)
      expect(HTTParty).to receive(:post).with("#{cache_url}/cache/invalidate-all", timeout: 3)
                                        .and_raise(StandardError.new('cache down'))

      post '/cache/invalidate-all'
      json_response = JSON.parse(last_response.body)
      cleared = json_response['cleared_services']
      expect(cleared).to include('python')
      expect(cleared.any? { |s| s.start_with?('go (failed:') }).to be true
      expect(cleared.any? { |s| s.start_with?('cache (failed:') }).to be true
    end
  end

  describe 'POST /diff' do
    before do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .and_return({ 'diff' => ['+ new line'] })
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .and_return({ 'score' => 90, 'issues' => [] })
    end

    context 'with missing parameters' do
      it 'returns 400 when old_content is missing' do
        post '/diff', { new_content: 'new' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing old_content or new_content')
      end

      it 'returns 400 when new_content is missing' do
        post '/diff', { old_content: 'old' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing old_content or new_content')
      end
    end

    context 'with valid parameters' do
      it 'returns diff and new code review' do
        post '/diff', { old_content: 'old', new_content: 'new' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['diff']['diff']).to eq(['+ new line'])
        expect(json_response['new_code_review']['score']).to eq(90)
      end
    end
  end

  describe 'POST /metrics' do
    before do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .and_return({ 'complexity' => 5 })
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .and_return({ 'score' => 80, 'issues' => ['issue1'] })
      allow_any_instance_of(PolyglotAPI).to receive(:calculate_quality_score).and_call_original
    end

    context 'with missing content' do
      it 'returns 400 error' do
        post '/metrics', {}.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing content')
      end
    end

    context 'with valid content' do
      it 'returns metrics, review, and overall_quality' do
        post '/metrics', { content: 'code' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['metrics']['complexity']).to eq(5)
        expect(json_response['review']['score']).to eq(80)
        expect(json_response).to have_key('overall_quality')
      end
    end
  end

  describe 'private helper methods' do
    let(:instance) do
      env = Rack::MockRequest.env_for('/')
      described_class.new(env)
    end

    describe '#check_service_health' do
      let(:url) { 'http://service' }

      it 'returns healthy when status code is 200' do
        allow(HTTParty).to receive(:get).with("#{url}/health", timeout: 2)
                                        .and_return(double(code: 200))
        result = instance.send(:check_service_health, url)
        expect(result).to eq({ status: 'healthy' })
      end

      it 'returns unhealthy when status code is not 200' do
        allow(HTTParty).to receive(:get).with("#{url}/health", timeout: 2)
                                        .and_return(double(code: 500))
        result = instance.send(:check_service_health, url)
        expect(result).to eq({ status: 'unhealthy' })
      end

      it 'returns unreachable with error message on exception' do
        allow(HTTParty).to receive(:get).with("#{url}/health", timeout: 2)
                                        .and_raise(StandardError.new('boom'))
        result = instance.send(:check_service_health, url)
        expect(result[:status]).to eq('unreachable')
        expect(result[:error]).to eq('boom')
      end
    end

    describe '#call_go_service' do
      let(:endpoint) { '/parse' }
      let(:data) { { content: 'code' } }
      let(:go_url) { 'http://go-service' }

      before do
        allow(instance).to receive_message_chain(:settings, :go_service_url).and_return(go_url)
      end

      it 'posts to go service and parses JSON response' do
        response_body = { 'language' => 'ruby' }.to_json
        expect(HTTParty).to receive(:post).with(
          "#{go_url}#{endpoint}",
          body: data.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 5
        ).and_return(double(body: response_body))

        result = instance.send(:call_go_service, endpoint, data)
        expect(result['language']).to eq('ruby')
      end

      it 'returns error hash when request fails' do
        expect(HTTParty).to receive(:post).and_raise(StandardError.new('go error'))
        result = instance.send(:call_go_service, endpoint, data)
        expect(result['error']).to eq('go error')
      end
    end

    describe '#call_python_service' do
      let(:endpoint) { '/review' }
      let(:data) { { content: 'code' } }
      let(:python_url) { 'http://python-service' }

      before do
        allow(instance).to receive_message_chain(:settings, :python_service_url).and_return(python_url)
      end

      it 'posts to python service and parses JSON response' do
        response_body = { 'score' => 95 }.to_json
        expect(HTTParty).to receive(:post).with(
          "#{python_url}#{endpoint}",
          body: data.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 5
        ).and_return(double(body: response_body))

        result = instance.send(:call_python_service, endpoint, data)
        expect(result['score']).to eq(95)
      end

      it 'returns error hash when request fails' do
        expect(HTTParty).to receive(:post).and_raise(StandardError.new('python error'))
        result = instance.send(:call_python_service, endpoint, data)
        expect(result['error']).to eq('python error')
      end
    end

    describe '#detect_language' do
      it 'detects go from .go extension' do
        expect(instance.send(:detect_language, 'main.go')).to eq('go')
      end

      it 'detects python from .py extension' do
        expect(instance.send(:detect_language, 'script.py')).to eq('python')
      end

      it 'detects ruby from .rb extension' do
        expect(instance.send(:detect_language, 'app.rb')).to eq('ruby')
      end

      it 'detects javascript from .js extension' do
        expect(instance.send(:detect_language, 'app.js')).to eq('javascript')
      end

      it 'detects typescript from .ts extension' do
        expect(instance.send(:detect_language, 'app.ts')).to eq('typescript')
      end

      it 'detects java from .java extension' do
        expect(instance.send(:detect_language, 'App.java')).to eq('java')
      end

      it 'returns unknown for unsupported extension' do
        expect(instance.send(:detect_language, 'file.txt')).to eq('unknown')
      end

      it 'returns unknown when path has no extension' do
        expect(instance.send(:detect_language, 'Makefile')).to eq('unknown')
      end
    end

    describe '#calculate_quality_score' do
      it 'returns 0.0 when metrics is nil' do
        result = instance.send(:calculate_quality_score, nil, { 'score' => 80 })
        expect(result).to eq(0.0)
      end

      it 'returns 0.0 when review is nil' do
        result = instance.send(:calculate_quality_score, { 'complexity' => 1 }, nil)
        expect(result).to eq(0.0)
      end

      it 'returns 0.0 when metrics has error' do
        result = instance.send(:calculate_quality_score, { 'error' => 'fail' }, { 'score' => 80 })
        expect(result).to eq(0.0)
      end

      it 'returns 0.0 when review has error' do
        result = instance.send(:calculate_quality_score, { 'complexity' => 1 }, { 'error' => 'fail' })
        expect(result).to eq(0.0)
      end

      it 'calculates score with complexity and issues penalties' do
        metrics = { 'complexity' => 3 }
        review = { 'score' => 80, 'issues' => %w[i1 i2] }
        # base_score = 0.8
        # complexity_penalty = 0.3
        # issue_penalty = 1.0
        # final_score = 0.8 - 0.3 - 1.0 = -0.5 -> 0 after clamp
        result = instance.send(:calculate_quality_score, metrics, review)
        expect(result).to eq(0)
      end

      it 'returns clamped score between 0 and 100' do
        metrics = { 'complexity' => 0 }
        review = { 'score' => 150, 'issues' => [] }
        result = instance.send(:calculate_quality_score, metrics, review)
        expect(result).to eq(100)

        metrics2 = { 'complexity' => 100 }
        review2 = { 'score' => 0, 'issues' => Array.new(10, 'i') }
        result2 = instance.send(:calculate_quality_score, metrics2, review2)
        expect(result2).to eq(0)
      end

      it 'handles missing complexity and issues gracefully' do
        metrics = {}
        review = { 'score' => 50 }
        # base_score = 0.5, no penalties
        result = instance.send(:calculate_quality_score, metrics, review)
        expect(result).to eq(50.0)
      end
    end
  end
end
