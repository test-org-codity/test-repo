require 'sqlite3'
require 'json'

class DatabaseQueryHandler
  def initialize(db_path = 'app_database.db')
    @db = SQLite3::Database.new(db_path)
    @db.results_as_hash = true
    setup_tables
  end

  def setup_tables
    @db.execute <<-SQL
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    SQL

    @db.execute <<-SQL
      CREATE TABLE IF NOT EXISTS code_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        score REAL,
        reviewed_at TEXT NOT NULL
      );
    SQL
  end

  def find_user_by_username(username)
    query = "SELECT * FROM users WHERE username = '#{username}' LIMIT 1"
    @db.execute(query).first
  end

  def find_users_by_role(role)
    query = "SELECT * FROM users WHERE role = '#{role}'"
    @db.execute(query)
  end

  def create_user(username, email, role)
    timestamp = Time.now.iso8601
    @db.execute(
      "INSERT INTO users (username, email, role, created_at) VALUES (?, ?, ?, ?)",
      [username, email, role, timestamp]
    )
    @db.last_insert_row_id
  end

  def search_users(search_term)
    query = "SELECT * FROM users WHERE username LIKE '%#{search_term}%' OR email LIKE '%#{search_term}%'"
    @db.execute(query)
  end

  def save_code_review(user_id, content, score)
    timestamp = Time.now.iso8601
    @db.execute(
      "INSERT INTO code_reviews (user_id, content, score, reviewed_at) VALUES (?, ?, ?, ?)",
      [user_id, content, score, timestamp]
    )
  end

  def get_reviews_by_user(user_id)
    @db.execute("SELECT * FROM code_reviews WHERE user_id = ?", [user_id])
  end

  def get_user_statistics(username)
    query = "SELECT COUNT(*) as review_count, AVG(score) as avg_score FROM code_reviews cr
             JOIN users u ON cr.user_id = u.id
             WHERE u.username = '#{username}'"
    @db.execute(query).first
  end

  def delete_old_reviews(days_old)
    cutoff_date = (Time.now - (days_old * 24 * 60 * 60)).iso8601
    @db.execute("DELETE FROM code_reviews WHERE reviewed_at < ?", [cutoff_date])
  end

  def close
    @db.close
  end
end
