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
    end
  end

  describe 'GET /cache/stats' do
    let(:stats_body) do
      { 'hits' => 10, 'misses' => 2 }.to_json
    end

    it 'returns cache stats on success' do
      response_double = instance_double(HTTParty::Response, body: stats_body)
      expect(HTTParty).to receive(:get)
        .with("#{PolyglotAPI.settings.cache_service_url}/cache/stats", timeout: 3)
        .and_return(response_double)

      get '/cache/stats'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['hits']).to eq(10)
      expect(json_response['misses']).to eq(2)
    end

    it 'returns error when request fails' do
      expect(HTTParty).to receive(:get).and_raise(StandardError.new('boom'))

      get '/cache/stats'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['error']).to eq('boom')
    end
  end

  describe 'POST /cache/invalidate' do
    let(:service) do
      'go'
    end

    let(:key) do
      'user:1'
    end

    let(:request_body) do
      { service: service, key: key }
    end

    let(:success_body) do
      { 'status' => 'ok' }.to_json
    end

    it 'returns 400 when service is missing' do
      post '/cache/invalidate', { key: key }.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(400)
      json_response = JSON.parse(last_response.body)
      expect(json_response['error']).to eq('Missing service parameter')
    end

    it 'accepts JSON body and forwards to cache service' do
      response_double = instance_double(HTTParty::Response, body: success_body)
      expect(HTTParty).to receive(:post).with(
        "#{PolyglotAPI.settings.cache_service_url}/cache/invalidate",
        body: { service: service, key: key }.to_json,
        headers: { 'Content-Type' => 'application/json' },
        timeout: 3
      ).and_return(response_double)

      post '/cache/invalidate', request_body.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['status']).to eq('ok')
    end

    it 'falls back to params when JSON is invalid' do
      response_double = instance_double(HTTParty::Response, body: success_body)
      expect(HTTParty).to receive(:post).and_return(response_double)

      post '/cache/invalidate', 'invalid-json', 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(200)
    end

    it 'returns error when cache service call fails' do
      expect(HTTParty).to receive(:post).and_raise(StandardError.new('failure'))

      post '/cache/invalidate', request_body.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['error']).to eq('failure')
    end
  end

  describe 'POST /cache/invalidate-all' do
    it 'clears all caches successfully' do
      expect(HTTParty).to receive(:post).with("#{PolyglotAPI.settings.go_service_url}/cache/clear", timeout: 3)
      expect(HTTParty).to receive(:post).with("#{PolyglotAPI.settings.python_service_url}/cache/clear", timeout: 3)
      expect(HTTParty).to receive(:post).with("#{PolyglotAPI.settings.cache_service_url}/cache/invalidate-all",
                                              timeout: 3)

      post '/cache/invalidate-all'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['message']).to eq('Cache invalidation completed')
      expect(json_response['cleared_services']).to include('go', 'python', 'cache')
    end

    it 'records failures for services that raise errors' do
      expect(HTTParty).to receive(:post).with("#{PolyglotAPI.settings.go_service_url}/cache/clear", timeout: 3)
                                        .and_raise(StandardError.new('go down'))
      expect(HTTParty).to receive(:post).with("#{PolyglotAPI.settings.python_service_url}/cache/clear", timeout: 3)
                                        .and_raise(StandardError.new('py down'))
      expect(HTTParty).to receive(:post).with("#{PolyglotAPI.settings.cache_service_url}/cache/invalidate-all",
                                              timeout: 3)
                                        .and_raise(StandardError.new('cache down'))

      post '/cache/invalidate-all'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['cleared_services']).to include(
        a_string_starting_with('go (failed:'),
        a_string_starting_with('python (failed:'),
        a_string_starting_with('cache (failed:')
      )
    end
  end

  describe 'POST /diff' do
    let(:old_content) do
      'old'
    end

    let(:new_content) do
      'new'
    end

    it 'returns 400 when old_content or new_content is missing' do
      post '/diff', { old_content: old_content }.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(400)
      json_response = JSON.parse(last_response.body)
      expect(json_response['error']).to eq('Missing old_content or new_content')
    end

    it 'returns diff and new review on success' do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .with('/diff', hash_including(:old_content, :new_content))
        .and_return({ 'changes' => [] })
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .with('/review', hash_including(:content))
        .and_return({ 'score' => 90, 'issues' => [] })

      post '/diff', { old_content: old_content, new_content: new_content }.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['diff']).to have_key('changes')
      expect(json_response['new_code_review']).to have_key('score')
    end
  end

  describe 'POST /metrics' do
    let(:content) do
      'some code'
    end

    it 'returns 400 when content is missing' do
      post '/metrics', {}.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(400)
      json_response = JSON.parse(last_response.body)
      expect(json_response['error']).to eq('Missing content')
    end

    it 'returns metrics, review and overall_quality on success' do
      allow_any_instance_of(PolyglotAPI).to receive(:call_go_service)
        .with('/metrics', hash_including(:content))
        .and_return({ 'complexity' => 3 })
      allow_any_instance_of(PolyglotAPI).to receive(:call_python_service)
        .with('/review', hash_including(:content))
        .and_return({ 'score' => 80, 'issues' => [] })

      post '/metrics', { content: content }.to_json, 'CONTENT_TYPE' => 'application/json'
      expect(last_response.status).to eq(200)
      json_response = JSON.parse(last_response.body)
      expect(json_response['metrics']).to have_key('complexity')
      expect(json_response['review']).to have_key('score')
      expect(json_response).to have_key('overall_quality')
    end
  end

  describe 'private helpers' do
    let(:instance) do
      described_class.new!
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
        expect(instance.send(:detect_language, 'Main.java')).to eq('java')
      end

      it 'returns unknown for unsupported extensions' do
        expect(instance.send(:detect_language, 'file.unknown')).to eq('unknown')
      end

      it 'returns unknown when there is no extension' do
        expect(instance.send(:detect_language, 'Makefile')).to eq('unknown')
      end
    end

    describe '#calculate_quality_score' do
      it 'returns 0.0 when metrics is nil' do
        expect(instance.send(:calculate_quality_score, nil, { 'score' => 80 })).to eq(0.0)
      end

      it 'returns 0.0 when review is nil' do
        expect(instance.send(:calculate_quality_score, { 'complexity' => 1 }, nil)).to eq(0.0)
      end

      it 'returns 0.0 when metrics has error' do
        expect(instance.send(:calculate_quality_score, { 'error' => 'x' }, { 'score' => 80 })).to eq(0.0)
      end

      it 'returns 0.0 when review has error' do
        expect(instance.send(:calculate_quality_score, { 'complexity' => 1 }, { 'error' => 'x' })).to eq(0.0)
      end

      it 'calculates score with penalties and clamps to range' do
        metrics = { 'complexity' => 5 }
        review = { 'score' => 90, 'issues' => %w[a b] }
        score = instance.send(:calculate_quality_score, metrics, review)
        expect(score).to be_between(0, 100)
      end

      it 'does not go below 0' do
        metrics = { 'complexity' => 100 }
        review = { 'score' => 0, 'issues' => Array.new(100, 'issue') }
        score = instance.send(:calculate_quality_score, metrics, review)
        expect(score).to eq(0)
      end

      it 'does not go above 100' do
        metrics = { 'complexity' => 0 }
        review = { 'score' => 200, 'issues' => [] }
        score = instance.send(:calculate_quality_score, metrics, review)
        expect(score).to eq(100)
      end
    end

    describe '#check_service_health' do
      it 'returns healthy when response code is 200' do
        response_double = instance_double(HTTParty::Response, code: 200)
        expect(HTTParty).to receive(:get).with('http://example.com/health', timeout: 2).and_return(response_double)
        result = instance.send(:check_service_health, 'http://example.com')
        expect(result[:status]).to eq('healthy')
      end

      it 'returns unhealthy when response code is not 200' do
        response_double = instance_double(HTTParty::Response, code: 500)
        expect(HTTParty).to receive(:get).with('http://example.com/health', timeout: 2).and_return(response_double)
        result = instance.send(:check_service_health, 'http://example.com')
        expect(result[:status]).to eq('unhealthy')
      end

      it 'returns unreachable when request raises error' do
        expect(HTTParty).to receive(:get).and_raise(StandardError.new('down'))
        result = instance.send(:check_service_health, 'http://example.com')
        expect(result[:status]).to eq('unreachable')
        expect(result[:error]).to eq('down')
      end
    end

    describe '#call_go_service' do
      let(:endpoint) do
        '/parse'
      end

      let(:data) do
        { content: 'code' }
      end

      it 'returns parsed JSON on success' do
        response_double = instance_double(HTTParty::Response, body: { language: 'ruby' }.to_json)
        expect(HTTParty).to receive(:post).with(
          "#{PolyglotAPI.settings.go_service_url}#{endpoint}",
          body: data.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 5
        ).and_return(response_double)

        result = instance.send(:call_go_service, endpoint, data)
        expect(result['language']).to eq('ruby')
      end

      it 'returns error hash when request fails' do
        expect(HTTParty).to receive(:post).and_raise(StandardError.new('go error'))
        result = instance.send(:call_go_service, endpoint, data)
        expect(result[:error]).to eq('go error')
      end
    end

    describe '#call_python_service' do
      let(:endpoint) do
        '/review'
      end

      let(:data) do
        { content: 'code' }
      end

      it 'returns parsed JSON on success' do
        response_double = instance_double(HTTParty::Response, body: { score: 95 }.to_json)
        expect(HTTParty).to receive(:post).with(
          "#{PolyglotAPI.settings.python_service_url}#{endpoint}",
          body: data.to_json,
          headers: { 'Content-Type' => 'application/json' },
          timeout: 5
        ).and_return(response_double)

        result = instance.send(:call_python_service, endpoint, data)
        expect(result['score']).to eq(95)
      end

      it 'returns error hash when request fails' do
        expect(HTTParty).to receive(:post).and_raise(StandardError.new('py error'))
        result = instance.send(:call_python_service, endpoint, data)
        expect(result[:error]).to eq('py error')
      end
    end
  end
end
