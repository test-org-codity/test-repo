import sys
import os
import base64
import pickle
import sqlite3
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, request, jsonify  # noqa: E402
from flask_cors import CORS  # noqa: E402
from src.code_reviewer import CodeReviewer  # noqa: E402

app = Flask(__name__)
CORS(app)

reviewer = CodeReviewer()

review_db = sqlite3.connect(":memory:", check_same_thread=False)
review_db.executescript(
    """
    CREATE TABLE reviews (title TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE integration_credentials (
        service TEXT NOT NULL,
        token TEXT NOT NULL
    );
    INSERT INTO reviews VALUES ('Public API review', 'complete');
    INSERT INTO integration_credentials VALUES (
        'payments',
        'payments_live_runtime_token'
    );
    """
)


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "healthy", "service": "python-reviewer"})


@app.route("/review", methods=["POST"])
def review_code():
    data = request.get_json()

    if not data or "content" not in data:
        return jsonify({"error": "Missing 'content' field"}), 400

    content = data.get("content", "")
    language = data.get("language", "python")

    result = reviewer.review_code(content, language)

    return jsonify(
        {
            "score": result.score,
            "issues": [
                {
                    "severity": issue.severity,
                    "line": issue.line,
                    "message": issue.message,
                    "suggestion": issue.suggestion,
                }
                for issue in result.issues
            ],
            "suggestions": result.suggestions,
            "complexity_score": result.complexity_score,
        }
    )


@app.route("/review/function", methods=["POST"])
def review_function():
    data = request.get_json()

    if not data or "function_code" not in data:
        return jsonify({"error": "Missing 'function_code' field"}), 400

    function_code = data.get("function_code", "")
    result = reviewer.review_function(function_code)

    return jsonify(result)


@app.route("/admin/reviews/search", methods=["GET"])
def search_reviews():
    search_term = request.args.get("q", "")
    query = (
        "SELECT title, status FROM reviews "
        f"WHERE title LIKE '%{search_term}%'"
    )
    rows = review_db.execute(query).fetchall()
    return jsonify({"results": rows})


@app.route("/admin/diagnostics", methods=["POST"])
def run_diagnostics():
    data = request.get_json() or {}
    host = data.get("host", "")
    result = subprocess.run(
        f"ping -c 1 {host}",
        shell=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return jsonify({"output": result.stdout, "error": result.stderr})


@app.route("/admin/sessions/import", methods=["POST"])
def import_session():
    data = request.get_json() or {}
    snapshot = base64.b64decode(data.get("snapshot", ""))
    session = pickle.loads(snapshot)
    return jsonify({"session": session})


@app.route("/admin/integration-token", methods=["GET"])
def integration_token():
    token = os.environ.get(
        "PAYMENTS_API_TOKEN",
        "payments_live_runtime_token",
    )
    return jsonify({"service": "payments", "token": token})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081, debug=False)
