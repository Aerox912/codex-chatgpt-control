from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

from .backend import (
    BackendClient,
    BackendProtocolError,
    BackendTransportError,
    DEFAULT_BACKEND_MAX_IN_FLIGHT,
    StdioBackendTransport,
    _validate_max_in_flight,
)


class NodeSidecarError(BackendTransportError):
    def __init__(
        self,
        message: str,
        *,
        returncode: int | None,
        stderr: str,
        fatal: bool = False,
        unresolved: bool = False,
        code: str | None = None,
        recoverable: bool = False,
    ) -> None:
        super().__init__(
            message,
            returncode=returncode,
            stderr=stderr,
            fatal=fatal,
            unresolved=unresolved,
            code=code,
        )
        # BackendProtocolError carries this logical-result bit while
        # BackendTransportError carries lifecycle bits.  Expose both on the
        # sidecar wrapper so callers do not need to inspect ``__cause__``.
        self.recoverable = recoverable


@dataclass(frozen=True)
class NodeSidecarTransport:
    """Run backend payloads through a spawned Node backend process.

    By default each ``run()`` call spawns a fresh backend subprocess and tears it down
    afterwards, so single calls stay stateless. Multi-command workflows can avoid paying
    Node startup per call by opening a persistent session, either explicitly with
    ``open()``/``close()`` or as a context manager::

        with NodeSidecarTransport(command=[...]) as transport:
            transport.run(first_payload)
            transport.run(second_payload)  # reuses the same backend process

    A transport-level failure (crash, invalid JSON, broken pipe) closes the persistent
    session because the subprocess is no longer trustworthy; protocol-level errors keep
    the session open, matching ``BackendClient`` semantics.
    """

    command: list[str]
    timeout_seconds: float = 600.0
    env: dict[str, str] | None = field(default=None)
    max_in_flight: int = DEFAULT_BACKEND_MAX_IN_FLIGHT
    _session: BackendClient | None = field(init=False, default=None, repr=False, compare=False)
    _session_lock: threading.RLock = field(init=False, default_factory=threading.RLock, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_max_in_flight(self.max_in_flight)

    def open(self) -> "NodeSidecarTransport":
        with self._session_lock:
            if self._session is None:
                object.__setattr__(self, "_session", self._create_client())
        return self

    def close(self) -> None:
        with self._session_lock:
            session = self._session
            if session is not None:
                object.__setattr__(self, "_session", None)
                session.close()

    def __enter__(self) -> "NodeSidecarTransport":
        return self.open()

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._session_lock:
            session = self._session
        if session is not None:
            return self._run_with(session, payload, close_after=False)
        return self._run_with(self._create_client(), payload, close_after=True)

    def request(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        """Issue one named backend command through the sidecar.

        ``run`` is the legacy runner-shaped convenience method.  Operation and
        Responses clients need the same persistent/fresh-session lifecycle with
        a command/payload surface, so delegate to ``BackendClient.request`` and
        preserve the structured transport/protocol metadata on failure.
        """

        with self._session_lock:
            session = self._session
        if session is not None:
            return self._request_with(session, command, payload, close_after=False)
        return self._request_with(self._create_client(), command, payload, close_after=True)

    async def request_async(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        """Async counterpart to :meth:`request` with identical sidecar policy."""

        with self._session_lock:
            session = self._session
        if session is not None:
            return await self._request_async_with(session, command, payload, close_after=False)
        return await self._request_async_with(self._create_client(), command, payload, close_after=True)

    def _create_client(self) -> BackendClient:
        return BackendClient(
            StdioBackendTransport(
                command=self.command,
                timeout_seconds=self.timeout_seconds,
                env=self.env,
                max_in_flight=self.max_in_flight,
            )
        )

    def _run_with(self, client: BackendClient, payload: dict[str, Any], *, close_after: bool) -> dict[str, Any]:
        try:
            return client.run(payload)
        except BackendTransportError as exc:
            if not close_after and exc.fatal:
                with self._session_lock:
                    if self._session is client:
                        object.__setattr__(self, "_session", None)
                client.close()
            raise self._sidecar_transport_error(exc) from exc
        except BackendProtocolError as exc:
            raise self._sidecar_protocol_error(exc) from exc
        finally:
            if close_after:
                client.close()

    def _request_with(
        self,
        client: BackendClient,
        command: str,
        payload: dict[str, Any] | None,
        *,
        close_after: bool,
    ) -> Any:
        try:
            return client.request(command, payload)
        except BackendTransportError as exc:
            self._retire_fatal_session(client, close_after=close_after, error=exc)
            raise self._sidecar_transport_error(exc) from exc
        except BackendProtocolError as exc:
            raise self._sidecar_protocol_error(exc) from exc
        finally:
            if close_after:
                client.close()

    async def _request_async_with(
        self,
        client: BackendClient,
        command: str,
        payload: dict[str, Any] | None,
        *,
        close_after: bool,
    ) -> Any:
        try:
            return await client.request_async(command, payload)
        except BackendTransportError as exc:
            self._retire_fatal_session(client, close_after=close_after, error=exc)
            raise self._sidecar_transport_error(exc) from exc
        except BackendProtocolError as exc:
            raise self._sidecar_protocol_error(exc) from exc
        finally:
            if close_after:
                client.close()

    def _retire_fatal_session(
        self,
        client: BackendClient,
        *,
        close_after: bool,
        error: BackendTransportError,
    ) -> None:
        if close_after or not error.fatal:
            return
        with self._session_lock:
            if self._session is client:
                object.__setattr__(self, "_session", None)
        client.close()

    @staticmethod
    def _sidecar_transport_error(error: BackendTransportError) -> NodeSidecarError:
        return NodeSidecarError(
            str(error),
            returncode=error.returncode,
            stderr=error.stderr,
            fatal=error.fatal,
            unresolved=error.unresolved,
            code=error.code,
        )

    @staticmethod
    def _sidecar_protocol_error(error: BackendProtocolError) -> NodeSidecarError:
        return NodeSidecarError(
            str(error),
            returncode=None,
            stderr="",
            code=error.code,
            recoverable=error.recoverable,
        )
