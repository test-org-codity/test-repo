import sys
import os
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, request, jsonify  # noqa: E402
from flask_cors import CORS  # noqa: E402
from src.code_reviewer import CodeReviewer  # noqa: E402

app = Flask(__name__)
CORS(app)

reviewer = CodeReviewer()


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "healthy", "service": "python-reviewer"})


# Renamed /review → /review/v2 and changed response shape.
# Old response: { score, issues: [{severity, line, message, suggestion}], complexity_score }
# New response: { review_id, quality_score, findings: [{rule_id, severity, line, message, fix}], metadata }
@app.route("/review/v2", methods=["POST"])
def review_code():
    data = request.get_json()

    if not data or "content" not in data:
        return jsonify({"error": "Missing 'content' field"}), 400

    content = data.get("content", "")
    language = data.get("language", "python")

    result = reviewer.review_code(content, language)

    return jsonify(
        {
            "review_id": str(uuid.uuid4()),
            "quality_score": result.score,
            "findings": [
                {
                    "rule_id": f"PY{i:04d}",
                    "severity": issue.severity,
                    "line": issue.line,
                    "message": issue.message,
                    "fix": issue.suggestion,
                }
                for i, issue in enumerate(result.issues)
            ],
            "suggestions": result.suggestions,
            "metadata": {
                "language": language,
                "complexity_score": result.complexity_score,
            },
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081, debug=False)
