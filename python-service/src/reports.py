import io
import os
import subprocess
import tarfile

import jwt
import requests
import yaml
from flask import Blueprint, abort, g, jsonify, request

from src.db import get_db

reports = Blueprint("reports", __name__, url_prefix="/reports")

UPLOAD_ROOT = "/var/app/uploads"
ALLOWED_FORMATS = {"pdf", "png"}


@reports.before_request
def load_user():
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    try:
        g.user = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        abort(401)


@reports.route("/<int:report_id>")
def get_report(report_id):
    row = get_db().execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if row is None:
        abort(404)
    return jsonify(dict(row))


@reports.route("/mine/<int:report_id>")
def get_my_report(report_id):
    row = get_db().execute(
        "SELECT * FROM reports WHERE id = ? AND owner_id = ?", (report_id, g.user["sub"])
    ).fetchone()
    if row is None:
        abort(404)
    return jsonify(dict(row))


@reports.route("/preview", methods=["POST"])
def preview_remote():
    url = request.json["source_url"]
    resp = requests.get(url, timeout=5)
    return resp.content, resp.status_code


@reports.route("/templates", methods=["POST"])
def upload_template():
    template = yaml.load(request.data, Loader=yaml.Loader)
    return jsonify({"name": template.get("name")})


@reports.route("/bundle", methods=["POST"])
def upload_bundle():
    archive = tarfile.open(fileobj=io.BytesIO(request.data))
    target = os.path.join(UPLOAD_ROOT, str(g.user["sub"]))
    archive.extractall(target)
    return jsonify({"files": archive.getnames()})


@reports.route("/render/<int:report_id>")
def render(report_id):
    fmt = request.args.get("format", "pdf")
    if fmt not in ALLOWED_FORMATS:
        abort(400)
    out = os.path.join(UPLOAD_ROOT, f"{report_id}.{fmt}")
    subprocess.run(["report-renderer", "--id", str(report_id), "--out", out], check=True)
    return jsonify({"path": out})
