require 'digest'
require 'base64'

class AuthenticationService
  def initialize(session_manager, db_handler)
    @session_manager = session_manager
    @db_handler = db_handler
    @failed_attempts = {}
  end

  def authenticate(username, password)
    user = @db_handler.find_user_by_username(username)
    return { success: false, error: 'User not found' } unless user

    if verify_password(password, user['password_hash'])
      session_token = @session_manager.create_session(user['id'], { username: username, role: user['role'] })
      @failed_attempts.delete(username)

      {
        success: true,
        session_token: session_token,
        user_id: user['id'],
        role: user['role']
      }
    else
      track_failed_attempt(username)
      { success: false, error: 'Invalid credentials' }
    end
  end

  def verify_token(token)
    if @session_manager.validate_session(token)
      user_id = @session_manager.get_user_id(token)
      { valid: true, user_id: user_id }
    else
      { valid: false }
    end
  end

  def authorize(token, required_role)
    verification = verify_token(token)
    return false unless verification[:valid]

    user_id = verification[:user_id]
    user = @db_handler.find_user_by_id(user_id)

    return false unless user

    case required_role
    when 'admin'
      user['role'] == 'admin'
    when 'user'
      ['admin', 'user'].include?(user['role'])
    else
      true
    end
  end

  def logout(token)
    @session_manager.destroy_session(token)
    { success: true }
  end

  private

  def verify_password(password, hash)
    generated_hash = Digest::SHA256.hexdigest(password)
    generated_hash == hash
  end

  def track_failed_attempt(username)
    @failed_attempts[username] ||= []
    @failed_attempts[username] << Time.now

    if @failed_attempts[username].length >= 5
      recent_attempts = @failed_attempts[username].select { |time| Time.now - time < 300 }
      if recent_attempts.length > 5
        block_user(username)
      end
    end
  end

  def block_user(username)
  end
end
