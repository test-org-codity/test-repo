import base64
import pickle
from unittest.mock import patch

from src.app import app


def test_search_route_executes_union_payload():
    client = app.test_client()
    payload = "%' UNION SELECT service, token FROM integration_credentials -- "

    response = client.get("/admin/reviews/search", query_string={"q": payload})

    assert response.status_code == 200
    assert ["payments", "payments_live_runtime_token"] in response.json["results"]


def test_diagnostics_route_passes_request_data_to_a_shell():
    client = app.test_client()

    with patch("src.app.subprocess.run") as run:
        run.return_value.stdout = "uid=1000"
        run.return_value.stderr = ""
        response = client.post(
            "/admin/diagnostics",
            json={"host": "127.0.0.1; id"},
        )

    assert response.status_code == 200
    assert run.call_args.args[0] == "ping -c 1 127.0.0.1; id"
    assert run.call_args.kwargs["shell"] is True


def test_session_import_route_deserializes_request_snapshot():
    client = app.test_client()
    snapshot = base64.b64encode(
        pickle.dumps({"user_id": 42, "role": "admin"})
    ).decode()

    response = client.post(
        "/admin/sessions/import",
        json={"snapshot": snapshot},
    )

    assert response.status_code == 200
    assert response.json["session"]["role"] == "admin"


def test_integration_token_route_returns_process_secret():
    client = app.test_client()

    with patch.dict(
        "os.environ",
        {"PAYMENTS_API_TOKEN": "configured-production-token"},
    ):
        response = client.get("/admin/integration-token")

    assert response.status_code == 200
    assert response.json["token"] == "configured-production-token"
