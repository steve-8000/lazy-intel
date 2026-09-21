"""Line-delimited JSON bridge for the read-only Serena API."""
from __future__ import annotations

import json
import sys
from typing import Any

from serena.lazy_read_api import LazyUnavailable, LazyReadSession, open_session


class Bridge:
    def __init__(self) -> None:
        self._sessions: dict[tuple[str, str, str], LazyReadSession] = {}

    def _session(self, payload: dict[str, Any]) -> LazyReadSession:
        root = str(payload.get("root", ""))
        language = str(payload.get("language", ""))
        server_path = str(payload.get("languageServerPath", ""))
        key = (root, language, server_path)
        if key not in self._sessions:
            self._sessions[key] = open_session(root, language, server_path)
        return self._sessions[key]

    def dispatch(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        if operation == "initialize":
            self._session(payload)
            return {"ready": True}
        session = self._session(payload)
        if operation == "symbol":
            return session.find_symbol(
                str(payload["namePath"]),
                depth=int(payload.get("depth", 0)),
                relative_path=str(payload.get("relativePath", "")),
                include_body=bool(payload.get("includeBody", False)),
                include_kinds=[int(x) for x in payload.get("includeKinds", [])],
                exclude_kinds=[int(x) for x in payload.get("excludeKinds", [])],
                substring_matching=bool(payload.get("substringMatching", False)),
                max_matches=int(payload.get("maxMatches", -1)),
            )
        if operation == "references":
            return session.find_referencing_symbols(
                str(payload["namePath"]),
                str(payload.get("relativePath", "")),
                include_kinds=[int(x) for x in payload.get("includeKinds", [])],
                exclude_kinds=[int(x) for x in payload.get("excludeKinds", [])],
            )
        if operation == "overview":
            return session.symbols_overview(str(payload["relativePath"]), depth=int(payload.get("depth", 0)))
        raise ValueError(f"unsupported semantic operation: {operation}")

    def close(self) -> None:
        for session in self._sessions.values():
            session.close()
        self._sessions.clear()


def main() -> int:
    bridge = Bridge()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request_id = None
            try:
                request = json.loads(line)
                if isinstance(request, dict):
                    candidate_id = request.get("requestId")
                    if isinstance(candidate_id, str) and candidate_id.strip():
                        request_id = candidate_id
                result = bridge.dispatch(str(request["operation"]), dict(request.get("payload", {})))
                response = {"requestId": request_id, "ok": True, "payload": result}
            except LazyUnavailable as exc:
                response = {"requestId": request_id, "ok": False, "code": "unavailable", "retryable": False, "message": str(exc)}
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                response = {"requestId": request_id, "ok": False, "code": "invalid_request", "retryable": False, "message": str(exc)}
            except Exception as exc:  # Serena/LSP failures are backend failures, not bridge crashes.
                response = {"requestId": request_id, "ok": False, "code": "backend_failed", "retryable": True, "message": str(exc)}
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    finally:
        bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
