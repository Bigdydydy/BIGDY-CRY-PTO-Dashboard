"""
Minimal JSON-over-HTTP client with rate-limit backoff (stdlib only).
"""

import json
import time
import urllib.error
import urllib.request

import config


def get_json(url: str, retries: int = 4, timeout: int = 20, backoff_sec: float = 30.0):
    """
    GET a JSON document. HTTP 429 and transient 5xx errors are retried with a
    growing pause; other failures raise immediately.
    """
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=config.HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
            wait = backoff_sec * (attempt + 1)
            print(f"[HTTP] {e.code} on {url[:90]}... retrying in {wait:.0f}s")
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt == retries:
                raise
            time.sleep(5.0 * (attempt + 1))
    raise last_err
