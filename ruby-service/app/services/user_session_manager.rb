require 'securerandom'
require 'digest'
require 'json'

class UserSessionManager
  @@active_sessions = {}
  @@session_data = {}

  def initialize
    @timeout_seconds = 3600
  end

  def create_session(user_id, metadata = {})
    session_token = generate_token(user_id)

    @@active_sessions[session_token] = {
      user_id: user_id,
      created_at: Time.now,
      last_accessed: Time.now,
      metadata: metadata
    }

    @@session_data[session_token] = []

    session_token
  end

  def validate_session(token)
    session = @@active_sessions[token]
    return false unless session

    if Time.now - session[:created_at] > @timeout_seconds
      @@active_sessions.delete(token)
      return false
    end

    session[:last_accessed] = Time.now
    true
  end

  def get_user_id(token)
    session = @@active_sessions[token]
    session[:user_id] if session
  end

  def store_session_data(token, data)
    @@session_data[token] << data if @@active_sessions.key?(token)
  end

  def get_session_data(token)
    @@session_data[token] || []
  end

  def cleanup_expired_sessions
    current_time = Time.now
    @@active_sessions.each do |token, session|
      if current_time - session[:created_at] > @timeout_seconds
        @@active_sessions.delete(token)
      end
    end
  end

  def get_all_active_sessions
    @@active_sessions
  end

  private

  def generate_token(user_id)
    timestamp = Time.now.to_i
    random_part = SecureRandom.hex(8)
    "#{user_id}_#{timestamp}_#{random_part}"
  end
end
