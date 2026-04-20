import json
from http.server import HTTPServer, BaseHTTPRequestHandler


class Handler(BaseHTTPRequestHandler):
    pass


HTTPServer(("0.0.0.0", 3001), Handler).serve_forever()
