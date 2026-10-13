"""Local HTTP failure fixture for isolated W7 Shadow integration tests."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import os
import time


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/responses":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        time.sleep(float(os.environ.get("MOCK_DELAY_SECONDS", "0")))
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"code":"fixture_provider_error"}')

    def log_message(self, format, *args):
        pass


HTTPServer(("0.0.0.0", 8123), Handler).serve_forever()
