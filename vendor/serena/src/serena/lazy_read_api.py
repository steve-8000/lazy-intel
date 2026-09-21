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


class LazyUnavailable(RuntimeError):
    """A semantic backend prerequisite is not available locally."""


@dataclass(frozen=True)
class ReadObservation:
    session_epoch: str
    position_encoding: str = "utf-8"
    scope: str = "disk-observed"
    document_version: int | None = None
    file_hash: str | None = None


class LazyReadSession:
    """Own one explicitly configured Serena project and its language servers."""

    def __init__(self, root: str, language: str, language_server_path: str | None = None) -> None:
        root_path = Path(root).resolve()
        if not root_path.is_dir():
            raise LazyUnavailable(f"semantic workspace does not exist: {root}")
        if not language_server_path:
            raise LazyUnavailable("no language_server_path supplied; lazy semantic mode never downloads language servers")
        ls_path = Path(language_server_path).expanduser().resolve()
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
        self._epoch = hashlib.sha256(f"{root_path}:{ls_path}".encode()).hexdigest()[:24]
        self._root = root_path
        self._language = language

    @property
    def observation(self) -> ReadObservation:
        return ReadObservation(session_epoch=self._epoch)

    def _hash(self, relative_path: str) -> str | None:
        path = (self._root / relative_path).resolve()
        if not path.is_file() or self._root not in path.parents:
            return None
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def _symbol_data(symbol: Any, depth: int, include_body: bool) -> dict[str, Any]:
        data = symbol.to_dict(
            name_path=True,
            name=True,
            kind=True,
            location=True,
            relative_path=True,
            body_location=True,
            body=include_body,
            depth=depth if not include_body else 0,
            children_name=True,
            children_name_path=False,
        )
        return dict(data)

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
        if max_matches > 0 and len(symbols) > max_matches:
            symbols = symbols[:max_matches]
        items = [self._symbol_data(s, depth, include_body) for s in symbols]
        return {"items": items, "observation": self._observation_for(relative_path)}

    def symbols_overview(self, relative_path: str, *, depth: int = 0) -> dict[str, Any]:
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
            if path is not None:
                try:
                    window = self._project.retrieve_content_around_line(path, ref.line, 1, 1)
                    # Two renderings on purpose. `context_display` keeps Serena's
                    # gutter format, which is what a human reads. `context` is the
                    # literal source slice: a consumer that re-reads the file must be
                    # able to compare it byte for byte, and the gutters would make
                    # every such comparison report a false mismatch.
                    context_display = window.to_display_string()
                    context = "\n".join(line.line_content for line in window.lines)
                    context_start_line = window.start_line
                    context_end_line = window.end_line
                except (OSError, ValueError, IndexError):
                    context = None
            item = self._symbol_data(symbol, 0, False)
            # `item` describes the *referencing symbol*, whose own file may differ
            # from the file the reference occurs in. `ref.line`/`ref.character`
            # address the latter, so the reference's path must travel with them or
            # a consumer will point the reader at the wrong file.
            item.update({
                "reference_relative_path": path,
                "reference_line": ref.line,
                "reference_character": ref.character,
                "context": context,
                "context_display": context_display,
                "context_start_line": context_start_line,
                "context_end_line": context_end_line,
            })
            items.append(item)
        return {"items": items, "observation": self._observation_for(relative_path)}

    def _observation_for(self, relative_path: str) -> dict[str, Any]:
        obs = self.observation
        return {
            "sessionEpoch": obs.session_epoch,
            "positionEncoding": obs.position_encoding,
            "scope": obs.scope,
            "documentVersion": obs.document_version,
            "fileHash": self._hash(relative_path) if relative_path else None,
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
