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
    let(:healthy_response) do
      instance_double(HTTParty::Response, code: 200)
    end

    before do
      allow(HTTParty).to receive(:get).and_return(healthy_response)
    end

    it 'returns status for all services' do
      get '/status'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['services']).to include('ruby', 'go', 'python', 'cache')
      expect(json_response['services']['ruby']['status']).to eq('healthy')
      expect(json_response['services']['go']['status']).to eq('healthy')
      expect(json_response['services']['python']['status']).to eq('healthy')
      expect(json_response['services']['cache']['status']).to eq('healthy')
    end

    context 'when a downstream service is unreachable' do
      before do
        call_count = 0
        allow(HTTParty).to receive(:get) do
          call_count += 1
          raise StandardError, 'connection failed' if call_count == 2

          healthy_response
        end
      end

      it 'marks the service as unreachable with error message' do
        get '/status'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['services']['go']['status']).to eq('unreachable')
        expect(json_response['services']['go']['error']).to eq('connection failed')
      end
    end
  end

  describe 'GET /cache/stats' do
    let(:stats_body) do
      { 'hits' => 10, 'misses' => 2 }.to_json
    end

    let(:httparty_response) do
      instance_double(HTTParty::Response, body: stats_body)
    end

    context 'when cache service responds successfully' do
      before do
        allow(HTTParty).to receive(:get).and_return(httparty_response)
      end

      it 'returns parsed cache stats' do
        get '/cache/stats'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['hits']).to eq(10)
        expect(json_response['misses']).to eq(2)
      end
    end

    context 'when cache service raises an error' do
      before do
        allow(HTTParty).to receive(:get).and_raise(StandardError.new('timeout'))
      end

      it 'returns an error message' do
        get '/cache/stats'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('timeout')
      end
    end
  end

  describe 'POST /cache/invalidate' do
    let(:cache_response_body) do
      { 'status' => 'ok' }.to_json
    end

    let(:httparty_response) do
      instance_double(HTTParty::Response, body: cache_response_body)
    end

    context 'with JSON body' do
      before do
        allow(HTTParty).to receive(:post).and_return(httparty_response)
      end

      it 'forwards invalidate request to cache service' do
        payload = { service: 'go', key: 'file:1' }
        post '/cache/invalidate', payload.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('ok')
        expect(HTTParty).to have_received(:post).with(
          "#{PolyglotAPI.settings.cache_service_url}/cache/invalidate",
          body: payload.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 3
        )
      end
    end

    context 'with form params' do
      before do
        allow(HTTParty).to receive(:post).and_return(httparty_response)
      end

      it 'accepts params without JSON body' do
        post '/cache/invalidate', service: 'python', key: 'k1'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('ok')
      end
    end

    context 'with invalid JSON body' do
      before do
        allow(HTTParty).to receive(:post).and_return(httparty_response)
      end

      it 'falls back to params when JSON parsing fails' do
        header 'CONTENT_TYPE', 'application/json'
        post '/cache/invalidate', 'invalid-json', service: 'ruby'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('ok')
      end
    end

    context 'when service parameter is missing' do
      it 'returns 400 with error message' do
        post '/cache/invalidate', { key: 'k1' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing service parameter')
      end
    end

    context 'when cache service raises an error' do
      before do
        allow(HTTParty).to receive(:post).and_raise(StandardError.new('connection error'))
      end

      it 'returns error message from exception' do
        post '/cache/invalidate', { service: 'go' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('connection error')
      end
    end
  end

  describe 'POST /cache/invalidate-all' do
    let(:success_response) do
      instance_double(HTTParty::Response, body: '{}')
    end

    context 'when all services succeed' do
      before do
        allow(HTTParty).to receive(:post).and_return(success_response)
      end

      it 'returns list of cleared services' do
        post '/cache/invalidate-all'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['message']).to eq('Cache invalidation completed')
        expect(json_response['cleared_services']).to match_array(%w[go python cache])
      end
    end

    context 'when some services fail' do
      before do
        allow(HTTParty).to receive(:post) do |url, _opts|
          raise StandardError, 'go down' if url.include?('go')

          success_response
        end
      end

      it 'includes failure messages for failed services' do
        post '/cache/invalidate-all'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        cleared = json_response['cleared_services']
        expect(cleared).to include(a_string_starting_with('go (failed: go down)'))
        expect(cleared).to include('python')
        expect(cleared).to include('cache')
      end
    end
  end

  describe 'POST /analyze additional cases' do
    context 'when content is missing' do
      it 'returns 400 with error message' do
        post '/analyze', { path: 'test.py' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing content')
      end
    end

    context 'when using form params instead of JSON' do
      before do
        allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
          .and_return({ 'language' => 'ruby', 'lines' => ['puts 1'] })
        allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
          .and_return({ 'score' => 90.0, 'issues' => [] })
      end

      it 'parses params and returns summary' do
        post '/analyze', content: 'puts 1', path: 'test.rb'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['summary']['language']).to eq('ruby')
        expect(json_response['summary']['review_score']).to eq(90.0)
      end
    end
  end

  describe 'POST /diff' do
    let(:diff_result) do
      { 'changes' => 3 }
    end

    let(:review_result) do
      { 'score' => 75.0, 'issues' => ['issue1'] }
    end

    before do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .with('/diff', hash_including(:old_content, :new_content))
        .and_return(diff_result)
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .with('/review', hash_including(:content))
        .and_return(review_result)
    end

    context 'with valid contents' do
      it 'returns diff and new code review' do
        post '/diff', { old_content: 'a', new_content: 'b' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['diff']).to eq(diff_result)
        expect(json_response['new_code_review']).to eq(review_result)
      end
    end

    context 'when contents are missing' do
      it 'returns 400 when old_content is missing' do
        post '/diff', { new_content: 'b' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing old_content or new_content')
      end

      it 'returns 400 when new_content is missing' do
        post '/diff', { old_content: 'a' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing old_content or new_content')
      end
    end
  end

  describe 'POST /metrics' do
    let(:metrics_result) do
      { 'complexity' => 5 }
    end

    let(:review_result) do
      { 'score' => 80.0, 'issues' => %w[i1 i2] }
    end

    before do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .with('/metrics', hash_including(:content))
        .and_return(metrics_result)
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .with('/review', hash_including(:content))
        .and_return(review_result)
    end

    context 'with valid content' do
      it 'returns metrics, review and overall_quality' do
        post '/metrics', { content: 'code' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['metrics']).to eq(metrics_result)
        expect(json_response['review']).to eq(review_result)
        expect(json_response).to have_key('overall_quality')
      end
    end

    context 'when content is missing' do
      it 'returns 400 with error message' do
        post '/metrics', {}.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing content')
      end
    end
  end

  describe 'private helper methods' do
    let(:instance) do
      described_class.new!
    end

    describe '#check_service_health' do
      let(:url) do
        'http://example.com'
      end

      context 'when service returns 200' do
        let(:response) do
          instance_double(HTTParty::Response, code: 200)
        end

        before do
          allow(HTTParty).to receive(:get).and_return(response)
        end

        it 'returns healthy status' do
          result = instance.send(:check_service_health, url)
          expect(result).to eq({ status: 'healthy' })
        end
      end

      context 'when service returns non-200' do
        let(:response) do
          instance_double(HTTParty::Response, code: 500)
        end

        before do
          allow(HTTParty).to receive(:get).and_return(response)
        end

        it 'returns unhealthy status' do
          result = instance.send(:check_service_health, url)
          expect(result).to eq({ status: 'unhealthy' })
        end
      end

      context 'when request raises an error' do
        before do
          allow(HTTParty).to receive(:get).and_raise(StandardError.new('boom'))
        end

        it 'returns unreachable status with error' do
          result = instance.send(:check_service_health, url)
          expect(result[:status]).to eq('unreachable')
          expect(result[:error]).to eq('boom')
        end
      end
    end

    describe '#call_go_service' do
      let(:endpoint) do
        '/parse'
      end

      let(:data) do
        { content: 'code' }
      end

      context 'when request succeeds with valid JSON' do
        let(:response_body) do
          { 'language' => 'ruby' }.to_json
        end

        let(:response) do
          instance_double(HTTParty::Response, body: response_body)
        end

        before do
          allow(HTTParty).to receive(:post).and_return(response)
        end

        it 'returns parsed JSON body' do
          result = instance.send(:call_go_service, endpoint, data)
          expect(result).to eq({ 'language' => 'ruby' })
        end
      end

      context 'when request raises an error' do
        before do
          allow(HTTParty).to receive(:post).and_raise(StandardError.new('go error'))
        end

        it 'returns hash with error message' do
          result = instance.send(:call_go_service, endpoint, data)
          expect(result).to eq({ error: 'go error' })
        end
      end
    end

    describe '#call_python_service' do
      let(:endpoint) do
        '/review'
      end

      let(:data) do
        { content: 'code' }
      end

      context 'when request succeeds with valid JSON' do
        let(:response_body) do
          { 'score' => 90.0 }.to_json
        end

        let(:response) do
          instance_double(HTTParty::Response, body: response_body)
        end

        before do
          allow(HTTParty).to receive(:post).and_return(response)
        end

        it 'returns parsed JSON body' do
          result = instance.send(:call_python_service, endpoint, data)
          expect(result).to eq({ 'score' => 90.0 })
        end
      end

      context 'when request raises an error' do
        before do
          allow(HTTParty).to receive(:post).and_raise(StandardError.new('python error'))
        end

        it 'returns hash with error message' do
          result = instance.send(:call_python_service, endpoint, data)
          expect(result).to eq({ error: 'python error' })
        end
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
        expect(instance.send(:detect_language, 'index.js')).to eq('javascript')
      end

      it 'detects typescript from .ts extension' do
        expect(instance.send(:detect_language, 'index.ts')).to eq('typescript')
      end

      it 'detects java from .java extension' do
        expect(instance.send(:detect_language, 'Main.java')).to eq('java')
      end

      it 'returns unknown for unsupported extension' do
        expect(instance.send(:detect_language, 'file.txt')).to eq('unknown')
      end

      it 'returns unknown when there is no extension' do
        expect(instance.send(:detect_language, 'Makefile')).to eq('unknown')
      end
    end

    describe '#calculate_quality_score' do
      context 'when metrics or review are nil' do
        it 'returns 0.0 when metrics is nil' do
          result = instance.send(:calculate_quality_score, nil, { 'score' => 80.0 })
          expect(result).to eq(0.0)
        end

        it 'returns 0.0 when review is nil' do
          result = instance.send(:calculate_quality_score, { 'complexity' => 1 }, nil)
          expect(result).to eq(0.0)
        end
      end

      context 'when metrics or review contain error' do
        it 'returns 0.0 when metrics has error' do
          result = instance.send(:calculate_quality_score, { 'error' => 'x' }, { 'score' => 80.0 })
          expect(result).to eq(0.0)
        end

        it 'returns 0.0 when review has error' do
          result = instance.send(:calculate_quality_score, { 'complexity' => 1 }, { 'error' => 'x' })
          expect(result).to eq(0.0)
        end
      end

      context 'with valid metrics and review' do
        it 'calculates score with penalties' do
          metrics = { 'complexity' => 3 }
          review = { 'score' => 80.0, 'issues' => [1, 2] }
          # base_score = 0.8
          # complexity_penalty = 0.3
          # issue_penalty = 1.0
          # final_score = -0.5 -> 0 after clamp
          result = instance.send(:calculate_quality_score, metrics, review)
          expect(result).to eq(0)
        end

        it 'returns clamped score between 0 and 100' do
          metrics = { 'complexity' => 0 }
          review = { 'score' => 120.0, 'issues' => [] }
          result = instance.send(:calculate_quality_score, metrics, review)
          expect(result).to eq(100)
        end

        it 'handles missing complexity and issues gracefully' do
          metrics = {}
          review = { 'score' => 50.0 }
          # base_score = 0.5, no penalties
          result = instance.send(:calculate_quality_score, metrics, review)
          expect(result).to eq(50.0)
        end
      end
    end
  end
end
