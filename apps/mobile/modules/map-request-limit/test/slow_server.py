# Servidor lento para test/main.swift: conta o pico de requisições simultâneas (GET /peak).
import http.server, socketserver, threading, time, sys
active = 0; peak = 0; lock = threading.Lock()
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def do_GET(self):
        global active, peak
        with lock:
            active += 1; peak = max(peak, active)
        time.sleep(0.15)
        if self.path == '/peak':
            body = str(peak).encode()
        else:
            body = (self.headers.get('User-Agent') or '').encode()
        with lock:
            active -= 1
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
S(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
