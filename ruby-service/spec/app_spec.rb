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
    let(:go_health) do
      { status: 'healthy' }
    end

    let(:python_health) do
      { status: 'unreachable', error: 'timeout' }
    end

    let(:cache_health) do
      { status: 'unhealthy' }
    end

    before do
      allow_any_instance_of(PolyglotAPI).to receive(:check_service_health) do |_, url|
        case url
        when PolyglotAPI.settings.go_service_url
          go_health
        when PolyglotAPI.settings.python_service_url
          python_health
        when PolyglotAPI.settings.cache_service_url
          cache_health
        end
      end
    end

    it 'returns aggregated status for all services' do
      get '/status'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['services']['ruby']['status']).to eq('healthy')
      expect(json_response['services']['go']).to eq(go_health)
      expect(json_response['services']['python']).to eq(python_health)
      expect(json_response['services']['cache']).to eq(cache_health)
    end
  end

  describe 'GET /cache/stats' do
    context 'when cache service responds successfully' do
      let(:stats_body) do
        { 'hits' => 10, 'misses' => 2 }.to_json
      end

      before do
        response_double = instance_double(HTTParty::Response, body: stats_body)
        allow(HTTParty).to receive(:get)
          .with("#{PolyglotAPI.settings.cache_service_url}/cache/stats", timeout: 3)
          .and_return(response_double)
      end

      it 'returns cache stats as json' do
        get '/cache/stats'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response).to eq(JSON.parse(stats_body))
      end
    end

    context 'when cache service request raises an error' do
      before do
        allow(HTTParty).to receive(:get).and_raise(StandardError.new('connection failed'))
      end

      it 'returns an error message' do
        get '/cache/stats'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('connection failed')
      end
    end
  end

  describe 'POST /cache/invalidate' do
    let(:service) do
      'go'
    end

    let(:key) do
      'file:123'
    end

    context 'with valid json body' do
      let(:request_body) do
        { service: service, key: key }.to_json
      end

      let(:cache_response_body) do
        { 'status' => 'ok', 'cleared' => true }.to_json
      end

      before do
        response_double = instance_double(HTTParty::Response, body: cache_response_body)
        allow(HTTParty).to receive(:post)
          .with(
            "#{PolyglotAPI.settings.cache_service_url}/cache/invalidate",
            body: { service: service, key: key }.to_json,
            headers: { 'Content-Type' => 'application/json' },
            timeout: 3
          )
          .and_return(response_double)
      end

      it 'forwards request to cache service and returns its response' do
        post '/cache/invalidate', request_body, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('ok')
        expect(json_response['cleared']).to eq(true)
      end
    end

    context 'with missing service parameter' do
      it 'returns 400 with error message' do
        post '/cache/invalidate', { key: key }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing service parameter')
      end
    end

    context 'with invalid json body falling back to params' do
      let(:cache_response_body) do
        { 'status' => 'ok' }.to_json
      end

      before do
        response_double = instance_double(HTTParty::Response, body: cache_response_body)
        allow(HTTParty).to receive(:post).and_return(response_double)
      end

      it 'uses params when json parsing fails' do
        env = { 'CONTENT_TYPE' => 'application/json' }
        post '/cache/invalidate?service=go&key=file:1', 'not-json', env
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['status']).to eq('ok')
      end
    end

    context 'when cache service request fails' do
      before do
        allow(HTTParty).to receive(:post).and_raise(StandardError.new('timeout'))
      end

      it 'returns error json' do
        post '/cache/invalidate', { service: service, key: key }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('timeout')
      end
    end
  end

  describe 'POST /cache/invalidate-all' do
    let(:go_url) do
      "#{PolyglotAPI.settings.go_service_url}/cache/clear"
    end

    let(:python_url) do
      "#{PolyglotAPI.settings.python_service_url}/cache/clear"
    end

    let(:cache_url) do
      "#{PolyglotAPI.settings.cache_service_url}/cache/invalidate-all"
    end

    context 'when all services succeed' do
      before do
        allow(HTTParty).to receive(:post).with(go_url, timeout: 3)
        allow(HTTParty).to receive(:post).with(python_url, timeout: 3)
        allow(HTTParty).to receive(:post).with(cache_url, timeout: 3)
      end

      it 'returns list of all cleared services' do
        post '/cache/invalidate-all'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['message']).to eq('Cache invalidation completed')
        expect(json_response['cleared_services']).to contain_exactly('go', 'python', 'cache')
      end
    end

    context 'when some services fail' do
      before do
        allow(HTTParty).to receive(:post).with(go_url, timeout: 3).and_raise(StandardError.new('go-down'))
        allow(HTTParty).to receive(:post).with(python_url, timeout: 3)
        allow(HTTParty).to receive(:post).with(cache_url, timeout: 3).and_raise(StandardError.new('cache-down'))
      end

      it 'marks failed services in the response list' do
        post '/cache/invalidate-all'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        cleared = json_response['cleared_services']
        expect(cleared).to include('python')
        expect(cleared.any? { |s| s.start_with?('go (failed:') }).to be true
        expect(cleared.any? { |s| s.start_with?('cache (failed:') }).to be true
      end
    end
  end

  describe 'POST /diff' do
    let(:old_content) do
      'old'
    end

    let(:new_content) do
      'new'
    end

    context 'with valid contents' do
      let(:diff_result) do
        { 'changes' => ['+ new', '- old'] }
      end

      let(:review_result) do
        { 'score' => 90, 'issues' => [] }
      end

      before do
        allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
          .with('/diff', hash_including(:old_content, :new_content))
          .and_return(diff_result)
        allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
          .with('/review', hash_including(:content))
          .and_return(review_result)
      end

      it 'returns diff and new code review' do
        post '/diff', { old_content: old_content, new_content: new_content }.to_json,
             'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['diff']).to eq(diff_result)
        expect(json_response['new_code_review']).to eq(review_result)
      end
    end

    context 'when required content is missing' do
      it 'returns 400 when old_content is missing' do
        post '/diff', { new_content: new_content }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing old_content or new_content')
      end

      it 'returns 400 when new_content is missing' do
        post '/diff', { old_content: old_content }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing old_content or new_content')
      end
    end

    context 'with invalid json falling back to params' do
      before do
        allow_any_instance_of(PolyglotAPI).to receive(:call_go_service).and_return({})
        allow_any_instance_of(PolyglotAPI).to receive(:call_python_service).and_return({})
      end

      it 'uses params when json parsing fails' do
        env = { 'CONTENT_TYPE' => 'application/json' }
        post '/diff?old_content=a&new_content=b', 'not-json', env
        expect(last_response.status).to eq(200)
      end
    end
  end

  describe 'POST /metrics' do
    let(:content) do
      'some code'
    end

    context 'with valid content' do
      let(:metrics_result) do
        { 'complexity' => 3 }
      end

      let(:review_result) do
        { 'score' => 80, 'issues' => [] }
      end

      before do
        allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
          .with('/metrics', hash_including(:content))
          .and_return(metrics_result)
        allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
          .with('/review', hash_including(:content))
          .and_return(review_result)
        allow_any_instance_of(PolyglotAPI).to receive(:calculate_quality_score)
          .and_return(75.0)
      end

      it 'returns metrics, review and overall_quality' do
        post '/metrics', { content: content }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['metrics']).to eq(metrics_result)
        expect(json_response['review']).to eq(review_result)
        expect(json_response['overall_quality']).to eq(75.0)
      end
    end

    context 'when content is missing' do
      it 'returns 400 with error' do
        post '/metrics', {}.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing content')
      end
    end

    context 'with invalid json body' do
      before do
        allow_any_instance_of(PolyglotAPI).to receive(:call_go_service).and_return({})
        allow_any_instance_of(PolyglotAPI).to receive(:call_python_service).and_return({})
        allow_any_instance_of(PolyglotAPI).to receive(:calculate_quality_score).and_return(0.0)
      end

      it 'falls back to params when json cannot be parsed' do
        env = { 'CONTENT_TYPE' => 'application/json' }
        post '/metrics?content=abc', 'not-json', env
        expect(last_response.status).to eq(200)
      end
    end
  end

  describe 'POST /analyze error and edge cases' do
    context 'when content is missing' do
      it 'returns 400 with error' do
        post '/analyze', { path: 'file.py' }.to_json, 'CONTENT_TYPE' => 'application/json'
        expect(last_response.status).to eq(400)
        json_response = JSON.parse(last_response.body)
        expect(json_response['error']).to eq('Missing content')
      end
    end

    context 'when invalid json is provided and params are used' do
      before do
        allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
          .and_return({ 'language' => 'ruby', 'lines' => ['puts 1'] })
        allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
          .and_return({ 'score' => 95, 'issues' => [] })
      end

      it 'falls back to params and succeeds' do
        env = { 'CONTENT_TYPE' => 'application/json' }
        post '/analyze?content=code&path=test.rb', 'not-json', env
        expect(last_response.status).to eq(200)
        json_response = JSON.parse(last_response.body)
        expect(json_response['summary']).not_to be_nil
      end
    end
  end

  describe 'private helper methods' do
    let(:instance) do
      PolyglotAPI.new!
    end

    describe '#detect_language' do
      it 'detects go from .go extension' do
        result = instance.send(:detect_language, 'main.go')
        expect(result).to eq('go')
      end

      it 'detects python from .py extension' do
        result = instance.send(:detect_language, 'script.py')
        expect(result).to eq('python')
      end

      it 'detects ruby from .rb extension' do
        result = instance.send(:detect_language, 'app.rb')
        expect(result).to eq('ruby')
      end

      it 'detects javascript from .js extension' do
        result = instance.send(:detect_language, 'index.js')
        expect(result).to eq('javascript')
      end

      it 'detects typescript from .ts extension' do
        result = instance.send(:detect_language, 'types.ts')
        expect(result).to eq('typescript')
      end

      it 'detects java from .java extension' do
        result = instance.send(:detect_language, 'Main.java')
        expect(result).to eq('java')
      end

      it 'returns unknown for unrecognized extension' do
        result = instance.send(:detect_language, 'file.unknown')
        expect(result).to eq('unknown')
      end

      it 'returns unknown when there is no extension' do
        result = instance.send(:detect_language, 'README')
        expect(result).to eq('unknown')
      end
    end

    describe '#calculate_quality_score' do
      context 'when metrics or review is nil' do
        it 'returns 0.0 when metrics is nil' do
          result = instance.send(:calculate_quality_score, nil, { 'score' => 80 })
          expect(result).to eq(0.0)
        end

        it 'returns 0.0 when review is nil' do
          result = instance.send(:calculate_quality_score, { 'complexity' => 1 }, nil)
          expect(result).to eq(0.0)
        end
      end

      context 'when metrics or review has error' do
        it 'returns 0.0 when metrics has error' do
          result = instance.send(:calculate_quality_score, { 'error' => 'failed' }, { 'score' => 80 })
          expect(result).to eq(0.0)
        end

        it 'returns 0.0 when review has error' do
          result = instance.send(:calculate_quality_score, { 'complexity' => 1 }, { 'error' => 'failed' })
          expect(result).to eq(0.0)
        end
      end

      context 'with valid metrics and review' do
        it 'calculates score considering complexity and issues' do
          metrics = { 'complexity' => 2 }
          review = { 'score' => 80, 'issues' => [1, 2] }
          result = instance.send(:calculate_quality_score, metrics, review)
          expected_base = 80.0 / 100.0
          expected_final = expected_base - (2 * 0.1) - (2 * 0.5)
          expected_score = (expected_final * 100).round(2)
          expected_score = [[expected_score, 0].max, 100].min
          expect(result).to eq(expected_score)
        end

        it 'clamps score at 0 when penalties are too high' do
          metrics = { 'complexity' => 100 }
          review = { 'score' => 10, 'issues' => Array.new(20, 1) }
          result = instance.send(:calculate_quality_score, metrics, review)
          expect(result).to eq(0)
        end

        it 'clamps score at 100 when result is above 100' do
          metrics = { 'complexity' => 0 }
          review = { 'score' => 200, 'issues' => [] }
          result = instance.send(:calculate_quality_score, metrics, review)
          expect(result).to eq(100)
        end

        it 'handles missing complexity and issues gracefully' do
          metrics = {}
          review = { 'score' => 50 }
          result = instance.send(:calculate_quality_score, metrics, review)
          expect(result).to eq(50.0)
        end
      end
    end

    describe '#check_service_health' do
      let(:url) do
        'http://example.com'
      end

      context 'when service returns 200' do
        before do
          response_double = instance_double(HTTParty::Response, code: 200)
          allow(HTTParty).to receive(:get)
            .with("#{url}/health", timeout: 2)
            .and_return(response_double)
        end

        it 'returns healthy status' do
          result = instance.send(:check_service_health, url)
          expect(result[:status]).to eq('healthy')
        end
      end

      context 'when service returns non-200' do
        before do
          response_double = instance_double(HTTParty::Response, code: 500)
          allow(HTTParty).to receive(:get)
            .with("#{url}/health", timeout: 2)
            .and_return(response_double)
        end

        it 'returns unhealthy status' do
          result = instance.send(:check_service_health, url)
          expect(result[:status]).to eq('unhealthy')
        end
      end

      context 'when request raises an error' do
        before do
          allow(HTTParty).to receive(:get).and_raise(StandardError.new('down'))
        end

        it 'returns unreachable status with error message' do
          result = instance.send(:check_service_health, url)
          expect(result[:status]).to eq('unreachable')
          expect(result[:error]).to eq('down')
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

      context 'when request succeeds' do
        let(:response_body) do
          { 'language' => 'ruby' }.to_json
        end

        before do
          response_double = instance_double(HTTParty::Response, body: response_body)
          allow(HTTParty).to receive(:post)
            .with(
              "#{PolyglotAPI.settings.go_service_url}#{endpoint}",
              body: data.to_json,
              headers: { 'Content-Type' => 'application/json' },
              timeout: 5
            )
            .and_return(response_double)
        end

        it 'returns parsed json body' do
          result = instance.send(:call_go_service, endpoint, data)
          expect(result).to eq(JSON.parse(response_body))
        end
      end

      context 'when request raises an error' do
        before do
          allow(HTTParty).to receive(:post).and_raise(StandardError.new('failed'))
        end

        it 'returns hash with error message' do
          result = instance.send(:call_go_service, endpoint, data)
          expect(result['error']).to eq('failed')
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

      context 'when request succeeds' do
        let(:response_body) do
          { 'score' => 90 }.to_json
        end

        before do
          response_double = instance_double(HTTParty::Response, body: response_body)
          allow(HTTParty).to receive(:post)
            .with(
              "#{PolyglotAPI.settings.python_service_url}#{endpoint}",
              body: data.to_json,
              headers: { 'Content-Type' => 'application/json' },
              timeout: 5
            )
            .and_return(response_double)
        end

        it 'returns parsed json body' do
          result = instance.send(:call_python_service, endpoint, data)
          expect(result).to eq(JSON.parse(response_body))
        end
      end

      context 'when request raises an error' do
        before do
          allow(HTTParty).to receive(:post).and_raise(StandardError.new('failed'))
        end

        it 'returns hash with error message' do
          result = instance.send(:call_python_service, endpoint, data)
          expect(result['error']).to eq('failed')
        end
      end
    end
  end
end
