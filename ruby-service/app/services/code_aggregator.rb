# frozen_string_literal: true

require 'httparty'
require 'json'

class CodeAggregator
  def initialize(go_service_url, python_service_url)
    @go_service_url = go_service_url
    @python_service_url = python_service_url
  end

  def aggregate_analysis(content, path)
    {
      timestamp: Time.now.iso8601,
      file_path: path,
      language: detect_language(path),
      analysis: {
        parsing: parse_with_go(content, path),
        review: review_with_python(content, path)
      }
    }
  end

  def compare_versions(old_content, new_content)
    {
      timestamp: Time.now.iso8601,
      comparison: {
        diff: diff_with_go(old_content, new_content),
        old_review: review_with_python(old_content),
        new_review: review_with_python(new_content)
      },
      improvement: calculate_improvement(old_content, new_content)
    }
  end

  private

  def parse_with_go(content, path)
    response = HTTParty.post(
      "#{@go_service_url}/parse",
      body: { content: content, path: path }.to_json,
      headers: { 'Content-Type' => 'application/json' }
    )
    JSON.parse(response.body)
  rescue StandardError => e
    { error: e.message }
  end

  def review_with_python(content, path = nil)
    language = path ? detect_language(path) : 'unknown'
    response = HTTParty.post(
      "#{@python_service_url}/review/v2",
      body: { content: content, language: language }.to_json,
      headers: { 'Content-Type' => 'application/json' }
    )
    JSON.parse(response.body)
  rescue StandardError => e
    { error: e.message }
  end

  def diff_with_go(old_content, new_content)
    response = HTTParty.post(
      "#{@go_service_url}/diff",
      body: { old_content: old_content, new_content: new_content }.to_json,
      headers: { 'Content-Type' => 'application/json' }
    )
    JSON.parse(response.body)
  rescue StandardError => e
    { error: e.message }
  end

  def calculate_improvement(old_content, new_content)
    old_review = review_with_python(old_content)
    new_review = review_with_python(new_content)

    return { error: 'Could not calculate improvement' } if old_review['error'] || new_review['error']

    old_score = old_review['quality_score'] || 0
    new_score = new_review['quality_score'] || 0

    {
      score_delta: (new_score - old_score).round(2),
      improvement_percentage: old_score.positive? ? (((new_score - old_score) / old_score) * 100).round(2) : 0,
      issues_reduced: (old_review['findings']&.length || 0) - (new_review['findings']&.length || 0)
    }
  end

  def detect_language(path)
    ext = File.extname(path).downcase
    {
      '.go' => 'go',
      '.py' => 'python',
      '.rb' => 'ruby',
      '.js' => 'javascript',
      '.ts' => 'typescript',
      '.java' => 'java'
    }[ext] || 'unknown'
  end
end
