import json
import os
import sqlite3
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DB_PATH = Path(os.environ.get("ORDERS_DB_PATH", "orders.db"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
UNIT_PRICE_MINOR = 499
MAX_QUANTITY = 100


def initialize_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, quantity INTEGER NOT NULL, total_minor INTEGER NOT NULL)")


def format_amount(total_minor):
    """Format an amount in minor units as a dollar display string."""
    return f"${total_minor / 100:.2f}"


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Order console</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><h1>Order console</h1><p>One item: $4.99</p><button id="checkout-submit" type="button"><span class="spinner" aria-hidden="true"></span>Place order</button><p id="status" role="status"></p></main>
<script>
const button = document.getElementById('checkout-submit');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true;
  button.dataset.busy = 'true';
  try {
    const response = await fetch('/checkout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({quantity: 1})});
    const result = await response.json();
    status.textContent = response.ok ? `Order ${result.id} placed for ${result.total}` : result.error;
  } catch (error) {
    status.textContent = 'Unable to place order. Please try again.';
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
  }
});
</script></body></html>"""


class OrderHandler(BaseHTTPRequestHandler):
    def send_body(self, status, body, content_type):
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == "/":
            self.send_body(200, PAGE, "text/html; charset=utf-8")
        elif self.path == "/styles.css":
            self.send_body(200, Path(__file__).with_name("styles.css").read_text(), "text/css; charset=utf-8")
        else:
            self.send_body(404, "Not found", "text/plain")

    def do_POST(self):
        if self.path != "/checkout":
            self.send_body(404, "Not found", "text/plain")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1024:
            self.send_body(400, json.dumps({"error": "Invalid request size"}), "application/json")
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            self.send_body(400, json.dumps({"error": "Invalid JSON"}), "application/json")
            return
        quantity = payload.get("quantity") if isinstance(payload, dict) else None
        if type(quantity) is not int or not 1 <= quantity <= MAX_QUANTITY:
            self.send_body(400, json.dumps({"error": "Quantity must be an integer from 1 to 100"}), "application/json")
            return
        order_id = str(uuid.uuid4())
        total_minor = quantity * UNIT_PRICE_MINOR
        with sqlite3.connect(DB_PATH) as connection:
            connection.execute("INSERT INTO orders (id, quantity, total_minor) VALUES (?, ?, ?)", (order_id, quantity, total_minor))
        self.send_body(201, json.dumps({"id": order_id, "total": format_amount(total_minor)}), "application/json")


def main():
    initialize_database()
    ThreadingHTTPServer((HOST, PORT), OrderHandler).serve_forever()


if __name__ == "__main__":
    main()
