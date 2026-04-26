"""
Seats.aero Award Flight Search — Local Proxy Server
Runs on http://localhost:5000 and forwards requests to the Seats.aero API.

Install dependencies:
    pip install flask flask-cors requests

Run:
    python proxy.py

Then open index.html in your browser.
"""

from flask import Flask, request, Response, jsonify
import requests
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Allow requests from file:// and any localhost origin

SEATS_AERO_BASE = "https://seats.aero/partnerapi"


@app.route("/proxy/search")
def proxy_search():
    # Accept API key from custom header (sent by the browser JS)
    api_key = request.headers.get("X-Api-Key", "").strip()
    if not api_key:
        return jsonify({"error": "Missing API key. Send X-Api-Key header."}), 400

    # Forward all query params as-is to seats.aero
    params = dict(request.args)

    headers = {
        "Partner-Authorization": api_key,
        "Accept": "application/json",
        "User-Agent": "AwardFlightSearch/1.0",
    }

    try:
        resp = requests.get(
            f"{SEATS_AERO_BASE}/search",
            params=params,
            headers=headers,
            timeout=45,
        )
        # Stream the raw JSON back to the browser
        return Response(
            resp.content,
            status=resp.status_code,
            content_type="application/json",
        )
    except requests.exceptions.Timeout:
        return jsonify({"error": "Seats.aero request timed out (45s). Try a narrower date range."}), 504
    except requests.exceptions.RequestException as exc:
        return jsonify({"error": f"Proxy connection error: {exc}"}), 502


@app.route("/health")
def health():
    return jsonify({"status": "ok", "proxy": "seats.aero"})


if __name__ == "__main__":
    print()
    print("  ✈  Award Flight Search Proxy")
    print("  " + "─" * 36)
    print("  Listening on  http://localhost:5000")
    print("  Health check  http://localhost:5000/health")
    print("  " + "─" * 36)
    print("  Open index.html in your browser")
    print()
    app.run(debug=False, port=5000, host="127.0.0.1")
