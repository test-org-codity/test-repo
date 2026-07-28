# frozen_string_literal: true

require 'sinatra/base'
require 'sinatra/json'
require 'rack/cors'
require 'httparty'
require 'json'

class PolyglotAPI < Sinatra::Base
  use Rack::Cors do
    allow do
      origins '*'
      resource '*', headers: :any, methods: %i[get post put delete options]
    end
  end

  configure do
    set :go_service_url, ENV['GO_SERVICE_URL'] || 'http://localhost:8080'
    set :python_service_url, ENV['PYTHON_SERVICE_URL'] || 'http://localhost:8081'
  end

  get '/health' do
    json status: 'healthy', service: 'ruby-api'
  end

  get '/status' do
    services_status = {
      ruby: { status: 'healthy' },
      go: check_service_health(settings.go_service_url),
      python: check_service_health(settings.python_service_url)
    }
    json services: services_status
  end

  post '/analyze' do
    begin
      body = request.body.read
      request.body.rewind
      request_data = body.empty? ? params : JSON.parse(body)
    rescue JSON::ParserError
      request_data = params
    end
    content = request_data['content'] || request_data[:content]
    path = request_data['path'] || request_data[:path] || 'unknown'

    return json(error: 'Missing content'), 400 unless content

    go_result = call_go_service('/parse', { content: content, path: path })
    python_result = call_python_service('/review/v2', { content: content, language: detect_language(path) })

    json(
      file_info: go_result,
      review: python_result,
      summary: {
        language: go_result['language'],
        lines: go_result['lines']&.length || 0,
        review_score: python_result['quality_score'],
        issues_count: python_result['findings']&.length || 0
      }
    )
  end

  post '/diff' do
    begin
      body = request.body.read
      request.body.rewind
      request_data = body.empty? ? params : JSON.parse(body)
    rescue JSON::ParserError
      request_data = params
    end
    old_content = request_data['old_content'] || request_data[:old_content]
    new_content = request_data['new_content'] || request_data[:new_content]

    return json(error: 'Missing old_content or new_content'), 400 unless old_content && new_content

    diff_result = call_go_service('/diff', { old_content: old_content, new_content: new_content })
    new_review = call_python_service('/review/v2', { content: new_content })

    json(
      diff: diff_result,
      new_code_review: new_review
    )
  end

  post '/metrics' do
    begin
      body = request.body.read
      request.body.rewind
      request_data = body.empty? ? params : JSON.parse(body)
    rescue JSON::ParserError
      request_data = params
    end
    content = request_data['content'] || request_data[:content]

    return json(error: 'Missing content'), 400 unless content

    metrics = call_go_service('/metrics', { content: content })
    review = call_python_service('/review/v2', { content: content })

    json(
      metrics: metrics,
      review: review,
      overall_quality: calculate_quality_score(metrics, review)
    )
  end

  private

  def check_service_health(url)
    response = HTTParty.get("#{url}/health", timeout: 2)
    { status: response.code == 200 ? 'healthy' : 'unhealthy' }
  rescue StandardError => e
    { status: 'unreachable', error: e.message }
  end

  def call_go_service(endpoint, data)
    response = HTTParty.post(
      "#{settings.go_service_url}#{endpoint}",
      body: data.to_json,
      headers: { 'Content-Type' => 'application/json' },
      timeout: 5
    )
    JSON.parse(response.body)
  rescue StandardError => e
    { error: e.message }
  end

  def call_python_service(endpoint, data)
    response = HTTParty.post(
      "#{settings.python_service_url}#{endpoint}",
      body: data.to_json,
      headers: { 'Content-Type' => 'application/json' },
      timeout: 5
    )
    JSON.parse(response.body)
  rescue StandardError => e
    { error: e.message }
  end

  def detect_language(path)
    ext = File.extname(path).downcase
    lang_map = {
      '.go' => 'go',
      '.py' => 'python',
      '.rb' => 'ruby',
      '.js' => 'javascript',
      '.ts' => 'typescript',
      '.java' => 'java'
    }
    lang_map[ext] || 'unknown'
  end

  def calculate_quality_score(metrics, review)
    return 0.0 unless metrics && review && !metrics['error'] && !review['error']

    complexity_penalty = (metrics['complexity'] || 0) * 0.1
    issue_penalty = (review['findings']&.length || 0) * 0.5
    review_score = review['quality_score'] || 0

    base_score = review_score / 100.0
    final_score = base_score - complexity_penalty - issue_penalty

    score = (final_score * 100).round(2)
    score.clamp(0, 100)
  end
end
