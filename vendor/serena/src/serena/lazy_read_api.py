# ADDED BY lazy-intel
"""Small, read-only Serena API for the private semantic worker.

This module intentionally does not import the Serena agent, MCP server or dashboard.
The language-server path is supplied by the caller; a missing explicit path is an
error rather than permission to use Serena's download providers.
"""
from __future__ import annotations

import hashlib
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence
from uuid import uuid4

class LazyUnavailable(RuntimeError):
    """A semantic backend prerequisite is not available locally."""


@dataclass(frozen=True)
class ReadObservation:
    session_epoch: str
    # LSP positions are UTF-16 unless initialization negotiates another encoding.
    position_encoding: str = "utf-16"
    scope: str = "unknown"
    document_version: int | None = None
    file_hash: str | None = None
    buffer_hash: str | None = None


class LazyReadSession:
    """Own one explicitly configured Serena project and its language servers."""

    def __init__(self, root: str, language: str, language_server_path: str | None = None) -> None:
        root_path = Path(root).resolve()
        if not root_path.is_dir():
            raise LazyUnavailable(f"semantic workspace does not exist: {root}")
        if not language_server_path:
            raise LazyUnavailable("no language_server_path supplied; lazy semantic mode never downloads language servers")
        supplied_ls_path = Path(language_server_path).expanduser()
        if not supplied_ls_path.is_absolute():
            raise LazyUnavailable("language_server_path must be absolute; lazy semantic mode never resolves PATH entries")
        ls_path = supplied_ls_path.resolve()
        if supplied_ls_path != ls_path:
            raise LazyUnavailable("language_server_path must be a canonical executable path")
        if not ls_path.is_file() or not os.access(ls_path, os.X_OK):
            raise LazyUnavailable(f"configured language server is not executable: {ls_path}")

        vendor_src = Path(__file__).resolve().parents[1]
        if str(vendor_src) not in sys.path:
            sys.path.insert(0, str(vendor_src))
        try:
            from serena.config.serena_config import ProjectConfig, SerenaConfig
            from serena.ls_manager import LanguageServerManager
            from serena.project import Project
            from solidlsp.ls_config import LanguageServerId
            from serena.symbol import LanguageServerSymbolRetriever
        except Exception as exc:  # pragma: no cover - depends on the selected Python environment
            raise LazyUnavailable(f"Serena import closure unavailable: {exc}") from exc

        try:
            ls_id = LanguageServerId(language)
        except ValueError as exc:
            raise LazyUnavailable(f"unsupported Serena language server: {language}") from exc

        # `ls_path` is the SolidLSP override that bypasses every dependency provider.
        config = SerenaConfig(
            web_dashboard=False,
            web_dashboard_open_on_launch=False,
            project_serena_folder_location=str(root_path / ".serena-lazy"),
            ls_specific_settings={language: {"ls_path": str(ls_path)}},
        )
        project_config = ProjectConfig(
            project_name=root_path.name,
            language_servers=[ls_id],
            ls_workspace_folders=[str(root_path)],
            read_only=True,
        )
        self._project = Project(project_root=str(root_path), project_config=project_config, serena_config=config)
        # Construct the manager explicitly so this surface does not rely on the agent context.
        self._manager: LanguageServerManager = self._project.create_language_server_manager()
        self._retriever = LanguageServerSymbolRetriever(self._project)
        self._initial_epoch = uuid4().hex
        self._last_session_epoch = self._initial_epoch
        self._server_epochs: list[tuple[Any, str]] = []
        self._root = root_path
        self._language = language
    def _safe_path(self, relative_path: Any) -> Path | None:
        if not isinstance(relative_path, str) or not relative_path or "\x00" in relative_path or "://" in relative_path:
            return None
        candidate = Path(relative_path)
        if candidate.is_absolute() or any(part == ".." for part in candidate.parts):
            return None
        try:
            resolved = (self._root / candidate).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if resolved != self._root and self._root not in resolved.parents:
            return None
        return resolved if resolved.is_file() else None
    def _hash(self, relative_path: str) -> str | None:
        path = self._safe_path(relative_path)
        if path is None:
            return None
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            return None
    def _symbol_data(self, symbol: Any, depth: int, include_body: bool) -> dict[str, Any]:
        relative_path = getattr(symbol, "relative_path", None)
        owned = self._safe_path(relative_path)
        kwargs = dict(name_path=True, name=True, kind=True, location=True, relative_path=True, body_location=True, body=include_body and owned is not None, depth=depth, children_name=True, children_name_path=False)
        result = dict(symbol.to_dict(**kwargs))
        relative_path = result.get("relative_path", relative_path)
        if isinstance(relative_path, str):
            result["file_hash"] = self._hash(relative_path)
        if result.get("kind") == "File" and isinstance(owned, Path) and isinstance(result.get("body_location"), dict):
            # The reader addresses lines by splitting the captured bytes on LF, so a
            # file ending in a newline keeps its final empty line and a lone CR is not
            # a line break. Deriving the File range any other way - str.splitlines()
            # breaks on VT, FF and the Unicode separators too - claims a line the
            # source snapshot cannot address, which makes the evidence incomplete.
            try:
                source_lines = owned.read_bytes().decode("utf-8").split("\n")
            except (OSError, UnicodeDecodeError):
                result.pop("body_location", None)
            else:
                result["body_location"] = {"start_line": 0, "end_line": len(source_lines) - 1}
        return result

    def _epoch_for_server(self, language_server: Any) -> str:
        for known_server, epoch in self._server_epochs:
            if known_server is language_server:
                return epoch
        epoch = uuid4().hex
        self._server_epochs.append((language_server, epoch))
        return epoch

    @property
    def observation(self) -> ReadObservation:
        return ReadObservation(session_epoch=self._initial_epoch)


    def _position_encoding_for(self, relative_path: str) -> str:
        """Return the server's negotiated LSP position encoding when exposed."""
        try:
            language_server = self._manager.get_language_server(relative_path)
            self._last_session_epoch = self._epoch_for_server(language_server)
            for candidate in (
                getattr(language_server, "position_encoding", None),
                getattr(language_server, "_position_encoding", None),
            ):
                if candidate in {"utf-8", "utf-16", "utf-32"}:
                    return str(candidate)
        except Exception:
            pass
        return self.observation.position_encoding


    def find_symbol(
        self,
        name_path: str,
        *,
        depth: int = 0,
        relative_path: str = "",
        include_body: bool = False,
        include_kinds: Sequence[int] = (),
        exclude_kinds: Sequence[int] = (),
        substring_matching: bool = False,
        max_matches: int = -1,
    ) -> dict[str, Any]:
        if relative_path and self._safe_path(relative_path) is None:
            raise ValueError("semantic path is outside the workspace")
        from solidlsp.ls_types import SymbolKind

        includes = [SymbolKind(k) for k in include_kinds] if include_kinds else None
        excludes = [SymbolKind(k) for k in exclude_kinds] if exclude_kinds else None
        symbols = self._retriever.find(
            name_path,
            include_kinds=includes,
            exclude_kinds=excludes,
            substring_matching=substring_matching,
            within_relative_path=relative_path or None,
        )
        truncated = max_matches > 0 and len(symbols) > max_matches
        omitted = max(0, len(symbols) - max_matches) if truncated else 0
        if truncated:
            symbols = symbols[:max_matches]
        items = [self._symbol_data(s, depth, include_body) for s in symbols]
        return {"items": items, "truncated": truncated, "omitted": omitted, "observation": self._observation_for(relative_path)}

    def symbols_overview(self, relative_path: str, *, depth: int = 0) -> dict[str, Any]:
        if self._safe_path(relative_path) is None:
            raise ValueError("semantic path is outside the workspace")
        overview = self._retriever.get_symbol_overview(relative_path)
        items: list[dict[str, Any]] = []
        for path, symbols in overview.items():
            for symbol in symbols:
                items.append(self._symbol_data(symbol, depth, False) | {"relative_path": path})
        return {"items": items, "observation": self._observation_for(relative_path)}

    def find_referencing_symbols(
        self,
        name_path: str,
        relative_path: str,
        *,
        include_kinds: Sequence[int] = (),
        exclude_kinds: Sequence[int] = (),
    ) -> dict[str, Any]:
        if self._safe_path(relative_path) is None:
            raise ValueError("semantic path is outside the workspace")
        from solidlsp.ls_types import SymbolKind

        includes = [SymbolKind(k) for k in include_kinds] if include_kinds else None
        excludes = [SymbolKind(k) for k in exclude_kinds] if exclude_kinds else None
        # This is Serena's own resolution and reference operation. It retains the
        # exact name-path rules and the LSP file-symbol context semantics.
        refs = self._retriever.find_referencing_symbols(
            name_path, relative_path, include_kinds=includes, exclude_kinds=excludes
        )
        items: list[dict[str, Any]] = []
        for ref in refs:
            symbol = ref.symbol
            path = ref.get_relative_path()
            context = None
            context_display = None
            context_start_line = None
            context_end_line = None
            if path is not None and self._safe_path(path) is not None:
                try:
                    window = self._project.retrieve_content_around_line(path, ref.line, 1, 1)
                    # Keep both a human rendering and the exact disk excerpt.
                    context_display = window.to_display_string()
                    source_path = (self._root / path).resolve()
                    if source_path != self._root and self._root not in source_path.parents:
                        raise ValueError("reference path escapes semantic workspace")
                    source_lines = source_path.read_bytes().decode("utf-8").splitlines(keepends=True)
                    context = "".join(source_lines[window.start_line:window.end_line + 1])
                    context_start_line = window.start_line
                    context_end_line = min(window.end_line, len(source_lines) - 1)
                except (OSError, ValueError, IndexError):
                    context = None
            item = self._symbol_data(symbol, 0, False)
            # `item` describes the *referencing symbol*, whose own file may differ
            # from the file the reference occurs in. `ref.line`/`ref.character`
            # address the latter, so the reference's path must travel with them or
            # a consumer will point the reader at the wrong file.
            item.update({
                "reference_relative_path": path,
                "file_hash": self._hash(path) if path is not None else None,
                "containing_file_hash": item.get("file_hash"),
                "reference_line": ref.line,
                "reference_character": ref.character,
                "context": context,
                "context_display": context_display,
                "context_start_line": context_start_line,
                "context_end_line": context_end_line,
            })
            items.append(item)
        return {"items": items, "observation": self._observation_for(relative_path)}
    def find_implementations(
        self,
        name_path: str,
        relative_path: str,
        *,
        include_body: bool = False,
        include_kinds: Sequence[int] = (),
        exclude_kinds: Sequence[int] = (),
    ) -> dict[str, Any]:
        if self._safe_path(relative_path) is None:
            raise ValueError("semantic path is outside the workspace")
        from solidlsp.ls_types import SymbolKind

        includes = [SymbolKind(k) for k in include_kinds] if include_kinds else None
        excludes = [SymbolKind(k) for k in exclude_kinds] if exclude_kinds else None
        symbols = self._retriever.find_implementing_symbols(
            name_path, relative_path, include_body=include_body, include_kinds=includes, exclude_kinds=excludes
        )
        items = [self._symbol_data(symbol, 0, include_body) for symbol in symbols]
        return {"items": items, "observation": self._observation_for(relative_path)}

    def get_diagnostics(self, relative_path: str) -> dict[str, Any]:
        """Query Serena's typed diagnostics path without converting it to prose."""
        if not relative_path:
            raise ValueError("diagnostics requires relative_path")
        if self._safe_path(relative_path) is None:
            raise ValueError("semantic path is outside the workspace")
        try:
            diagnostics = self._retriever.get_file_diagnostics(relative_path)
        except (AttributeError, NotImplementedError) as exc:
            return {
                "items": [],
                "message": f"language server does not expose file diagnostics: {exc}",
                "observation": self._observation_for(relative_path, "unsupported"),
            }
        items: list[dict[str, Any]] = []
        for diagnostic in diagnostics:
            item = dict(diagnostic)
            item["relative_path"] = relative_path
            item["file_hash"] = self._hash(relative_path)
            item["diagnostic"] = True
            items.append(item)
        language_server = self._manager.get_language_server(relative_path)
        diagnostics_status = getattr(language_server, "_last_diagnostics_status", "not_reported")
        observation = self._observation_for(relative_path, diagnostics_status)
        result: dict[str, Any] = {"items": items, "observation": observation}
        if diagnostics_status != "complete":
            result["message"] = "language server did not publish or return diagnostics"
        return result

    def _owned_document_observation(self, relative_path: str) -> tuple[str, int, str] | None:
        """Return owned LSP buffer state, rejecting content unrelated to disk."""
        try:
            path = self._safe_path(relative_path)
            if path is None:
                return None
            disk_bytes = path.read_bytes()
            disk_hash = hashlib.sha256(disk_bytes).hexdigest()
            normalized_hash = hashlib.sha256(disk_bytes.replace(b"\r\n", b"\n")).hexdigest()
            language_server = self._manager.get_language_server(relative_path)
            with language_server.open_file(relative_path, open_in_ls=True) as file_buffer:
                buffer_hash = hashlib.sha256(file_buffer.contents.encode("utf-8")).hexdigest()
                scope = "own-buffer" if buffer_hash in {disk_hash, normalized_hash} else "unknown"
                return (scope, int(file_buffer.version), buffer_hash)
        except Exception:
            return None

    def _observation_for(self, relative_path: str, diagnostics_status: str = "not_reported") -> dict[str, Any]:
        obs = self.observation
        position_encoding = self._position_encoding_for(relative_path) if relative_path else obs.position_encoding
        owned = self._owned_document_observation(relative_path) if relative_path else None
        scope = owned[0] if owned else obs.scope
        document_version = owned[1] if owned else obs.document_version
        file_hash = self._hash(relative_path) if relative_path else None
        buffer_hash = owned[2] if owned else None
        return {
            "sessionEpoch": self._last_session_epoch if relative_path else obs.session_epoch,
            "positionEncoding": position_encoding,
            "scope": scope,
            "documentVersion": document_version,
            "fileHash": file_hash,
            "bufferHash": buffer_hash,
            "relativePath": relative_path or None,
            "diagnosticsStatus": diagnostics_status,
        }

    def close(self) -> None:
        self._project.shutdown()


def open_session(root: str, language: str, language_server_path: str | None = None) -> LazyReadSession:
    return LazyReadSession(root, language, language_server_path)


def find_symbol(session: LazyReadSession, **kwargs: Any) -> dict[str, Any]:
    return session.find_symbol(**kwargs)


def find_referencing_symbols(session: LazyReadSession, **kwargs: Any) -> dict[str, Any]:
    return session.find_referencing_symbols(**kwargs)


def symbols_overview(session: LazyReadSession, **kwargs: Any) -> dict[str, Any]:
    return session.symbols_overview(**kwargs)
