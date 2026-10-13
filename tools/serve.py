"""本地开发服务器：禁用缓存，修改 JS 后刷新即生效。用法：python tools/serve.py [端口]"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=root)
    print(f"FOC 可视化：http://localhost:{port}")
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
