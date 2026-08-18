from __future__ import annotations

import asyncio
import atexit
import contextvars
import concurrent.futures
import functools
import inspect
import math
import queue
import threading
from collections.abc import Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from .agent import Agent
from .commands import wire_kwargs
from .models import BackendEvent, ChatGPTResponse, ChatGPTRunResult, CommandDescriptor, CommandResult, SequencePlan
from .operations import AsyncOperationsClient
from .primitives import _transactional_command_error_result
from .runner import (
    TransactionalInputError,
    _UNSAFE_FIELD_MARKER,
    _operation_id_from_input,
    _unsupported_run_result,
    run_transactional_async,
)
from .responses import (
    _merge_create_args,
    normalize_create_args,
    response_from_run_result,
    responses_create_args_to_run_input,
    unsupported_response,
    validate_responses_create_args,
)
from .workflows import _attach_doctor_compatibility


class AsyncBackendProtocol(Protocol):
    def request(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        ...


class AsyncRunTransport(Protocol):
    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Legacy async sidecar run shape kept as a compatibility fallback."""
        ...


DEFAULT_ASYNC_BACKEND_WORKERS = 8
DEFAULT_ASYNC_STREAM_WORKERS = 16
DEFAULT_ASYNC_CLEANUP_WORKERS = 4
DEFAULT_ASYNC_STREAM_CLOSE_TIMEOUT_SECONDS = 5.0
DEFAULT_ASYNC_CLIENT_CLOSE_TIMEOUT_SECONDS = 5.0
# Keep cancellation observation strictly bounded, but long enough for a
# responsive provider task to retire before a caller is told it can retry.
ASYNC_CLEANUP_CANCEL_GRACE_SECONDS = 0.25


def _validate_timeout_seconds(value: float, *, name: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ValueError(f"{name} must be a positive finite number")


class _DaemonExecutor:
    """Small bounded executor whose workers cannot hold interpreter exit."""

    def __init__(self, *, max_workers: int, thread_name_prefix: str) -> None:
        self._queue: queue.Queue[tuple[concurrent.futures.Future[Any], Callable[..., Any]] | None] = queue.Queue(
            maxsize=max_workers * 8,
        )
        self._lock = threading.Lock()
        self._closed = False
        self._workers = [
            threading.Thread(
                target=self._worker,
                name=f"{thread_name_prefix}_{index}",
                daemon=True,
            )
            for index in range(max_workers)
        ]
        for worker in self._workers:
            worker.start()

    def submit(self, method: Callable[..., Any], *args: Any) -> concurrent.futures.Future[Any]:
        future: concurrent.futures.Future[Any] = concurrent.futures.Future()
        work = (future, functools.partial(method, *args))
        with self._lock:
            if self._closed:
                raise RuntimeError("Async backend executor is closed.")
            try:
                self._queue.put_nowait(work)
            except queue.Full as exc:
                raise RuntimeError("Async backend executor queue is full.") from exc
        return future

    def _worker(self) -> None:
        while True:
            work = self._queue.get()
            if work is None:
                return
            future, method = work
            if not future.set_running_or_notify_cancel():
                continue
            try:
                result = method()
            except BaseException as exc:
                future.set_exception(exc)
            else:
                future.set_result(result)

    def shutdown(self, *, wait: bool = False, cancel_futures: bool = True) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if cancel_futures:
                while True:
                    try:
                        work = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if work is not None:
                        work[0].cancel()
            for _worker in self._workers:
                try:
                    self._queue.put_nowait(None)
                except queue.Full:
                    # A running worker will eventually consume work, but the
                    # worker is daemonized so shutdown never becomes a
                    # process-liveness dependency.
                    break
        if wait:
            for worker in self._workers:
                worker.join()


class _AsyncExecutionCancelled(asyncio.CancelledError):
    """Cancellation of an owned executor admission.

    ``asyncio`` cancellation can cancel a queued ``concurrent.futures`` work
    item before a worker has called the provider.  Once a worker is running,
    cancelling the await only detaches the caller; the daemon worker may have
    written to a sidecar already.  Keeping that distinction lets the backend
    transport release an unsent reservation without incorrectly tombstoning a
    route that may have produced late output.
    """

    def __init__(self, *, started: bool) -> None:
        super().__init__()
        self.started = started


class _OwnedAsyncExecutor:
    """A bounded executor that is owned by one async-client lifecycle.

    ``asyncio.to_thread`` uses the event loop's process-wide default executor.
    A blocked synchronous stream iterator can therefore consume every default
    worker and prevent unrelated unary work from starting.  These pools are
    deliberately separate from that executor and from one another. Shutdown
    is non-blocking: queued work is cancelled, while an already-running
    synchronous provider call is allowed to finish in its own daemon worker.
    A cancellation-hostile async provider coroutine is different: it remains
    bound to the event loop until it cooperates with cancellation.
    """

    def __init__(self, *, max_workers: int, thread_name_prefix: str) -> None:
        if (
            isinstance(max_workers, bool)
            or not isinstance(max_workers, int)
            or max_workers <= 0
            or max_workers > 128
        ):
            raise ValueError("max_workers must be a bounded positive integer")
        self._executor = _DaemonExecutor(max_workers=max_workers, thread_name_prefix=thread_name_prefix)
        self._lock = threading.Lock()
        self._closed = False

    async def run(self, method: Callable[..., Any], *args: Any) -> Any:
        loop = asyncio.get_running_loop()
        with self._lock:
            if self._closed:
                raise RuntimeError("Async backend executor is closed.")
            # Submit directly to the owned daemon executor instead of using
            # ``loop.run_in_executor``.  The wrapped concurrent future tells
            # us whether cancellation removed queued work before a provider
            # call started, which is required for deterministic reservation
            # release in BackendClient.request_async.
            future = self._executor.submit(method, *args)
        wrapped = asyncio.wrap_future(future, loop=loop)
        try:
            return await wrapped
        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            if not future.cancelled() and (
                current_task is None or current_task.cancelling() == 0
            ):
                # A provider may legitimately raise CancelledError as its
                # result.  Do not rewrite provider failures as caller
                # cancellation unless the awaiting task is actually being
                # cancelled or the work item itself was canceled pre-start.
                raise
            raise _AsyncExecutionCancelled(started=not future.cancelled()) from None

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            # Waiting here would make client shutdown hostage to a provider
            # iterator that ignores close.  Running calls remain isolated in
            # this owned pool and cannot consume the event-loop default pool.
            self._executor.shutdown(wait=False, cancel_futures=True)


class _AsyncExecution:
    """Lifecycle for request, stream-step, and cleanup worker pools."""

    def __init__(
        self,
        *,
        backend_workers: int = DEFAULT_ASYNC_BACKEND_WORKERS,
        stream_workers: int = DEFAULT_ASYNC_STREAM_WORKERS,
        cleanup_workers: int = DEFAULT_ASYNC_CLEANUP_WORKERS,
    ) -> None:
        self._backend_workers = backend_workers
        self._stream_workers = stream_workers
        self._cleanup_workers = cleanup_workers
        self._backend: _OwnedAsyncExecutor | None = None
        self._stream: _OwnedAsyncExecutor | None = None
        self._cleanup: _OwnedAsyncExecutor | None = None
        self._lock = threading.Lock()
        self._closed = False
        self._close_requested = False
        self._active_streams = 0

    def _get_pool(self, kind: str) -> _OwnedAsyncExecutor:
        with self._lock:
            if kind == "backend" and (self._closed or self._close_requested):
                raise RuntimeError("Async backend executor is closed.")
            pool = getattr(self, f"_{kind}")
            if pool is None:
                if kind == "backend":
                    workers = self._backend_workers
                elif kind == "stream":
                    workers = self._stream_workers
                else:
                    workers = self._cleanup_workers
                pool = _OwnedAsyncExecutor(
                    max_workers=workers,
                    thread_name_prefix=f"chatgpt-async-{kind}",
                )
                setattr(self, f"_{kind}", pool)
            return pool

    async def run_backend(self, method: Callable[..., Any], *args: Any) -> Any:
        return await self._get_pool("backend").run(method, *args)

    async def run_stream(self, method: Callable[..., Any], *args: Any) -> Any:
        return await self._get_pool("stream").run(method, *args)

    async def run_cleanup(self, method: Callable[..., Any], *args: Any) -> Any:
        return await self._get_pool("cleanup").run(method, *args)

    def acquire_stream(self) -> None:
        with self._lock:
            if self._closed or self._close_requested:
                raise RuntimeError("Async client lifecycle is closed.")
            self._active_streams += 1

    def request_close(self) -> None:
        """Atomically fence fresh backend work before caller-facing cleanup."""

        with self._lock:
            self._close_requested = True

    def assert_backend_open(self) -> None:
        with self._lock:
            if self._closed or self._close_requested:
                raise RuntimeError("Async client lifecycle is closed.")

    def release_stream(self) -> None:
        with self._lock:
            if self._active_streams <= 0:
                return
            self._active_streams -= 1
            if self._closed and self._active_streams == 0:
                stream = self._stream
                cleanup = self._cleanup
                self._stream = None
                self._cleanup = None
            else:
                stream = cleanup = None
        if stream is not None:
            stream.close()
        if cleanup is not None:
            cleanup.close()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._close_requested = True
            self._closed = True
            backend = self._backend
            if self._active_streams == 0:
                stream = self._stream
                cleanup = self._cleanup
                self._stream = None
                self._cleanup = None
            else:
                stream = cleanup = None
        if backend is not None:
            backend.close()
        if stream is not None:
            stream.close()
        if cleanup is not None:
            cleanup.close()


_ACTIVE_ASYNC_EXECUTION: contextvars.ContextVar[_AsyncExecution | None] = contextvars.ContextVar(
    "codex_chatgpt_control_async_execution",
    default=None,
)
_FALLBACK_ASYNC_EXECUTION = _AsyncExecution()
atexit.register(_FALLBACK_ASYNC_EXECUTION.close)


def _resolve_execution(execution: _AsyncExecution | None = None) -> _AsyncExecution:
    return execution or _ACTIVE_ASYNC_EXECUTION.get() or _FALLBACK_ASYNC_EXECUTION


async def _run_in_execution(
    method: Callable[..., Any],
    *args: Any,
    execution: _AsyncExecution | None = None,
    pool: str = "backend",
) -> Any:
    selected = _resolve_execution(execution)
    if pool == "stream":
        return await selected.run_stream(method, *args)
    if pool == "cleanup":
        return await selected.run_cleanup(method, *args)
    return await selected.run_backend(method, *args)


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def invoke_backend(
    method: Callable[..., Any],
    *args: Any,
    execution: _AsyncExecution | None = None,
    pool: str = "backend",
) -> Any:
    """Invoke sync backend methods off-loop while preserving async methods."""

    selected = _resolve_execution(execution)
    if pool == "backend":
        selected.assert_backend_open()
    if inspect.iscoroutinefunction(method):
        token = _ACTIVE_ASYNC_EXECUTION.set(selected)
        try:
            return await method(*args)
        finally:
            _ACTIVE_ASYNC_EXECUTION.reset(token)
    # A synchronous backend request may block on a pipe read for minutes.  Do
    # not call it before to_thread, even if it eventually returns an awaitable.
    result = await _run_in_execution(method, *args, execution=selected, pool=pool)
    if inspect.isawaitable(result):
        token = _ACTIVE_ASYNC_EXECUTION.set(selected)
        try:
            return await result
        finally:
            _ACTIVE_ASYNC_EXECUTION.reset(token)
    return result


async def async_request_backend(
    backend: Any,
    command: str,
    payload: dict[str, Any] | None = None,
    *,
    execution: _AsyncExecution | None = None,
) -> Any:
    selected = _resolve_execution(execution)
    selected.assert_backend_open()
    request_async = getattr(backend, "request_async", None)
    if callable(request_async):
        return await invoke_backend(request_async, command, payload or {}, execution=selected)
    request = getattr(backend, "request", None)
    if not callable(request):
        raise RuntimeError(f"This ChatGPT backend does not support {command}.")
    return await invoke_backend(request, command, payload or {}, execution=selected)


def command_result_from_wire(value: Any, command: str) -> CommandResult:
    if not isinstance(value, dict):
        raise RuntimeError(f"{command} backend result must be a CommandResult object.")
    return CommandResult.from_wire(value)


async def async_command_result(
    backend: Any,
    command: str,
    payload: dict[str, Any],
    *,
    execution: _AsyncExecution,
) -> CommandResult:
    try:
        return command_result_from_wire(
            await async_request_backend(backend, command, payload, execution=execution),
            command,
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:
        transactional = _transactional_command_error_result(payload, error)
        if transactional is not None:
            return transactional
        raise


async def _await_task_bounded(task: asyncio.Future[Any], timeout_seconds: float) -> Any:
    """Await a lifecycle task without allowing provider cleanup to hang us."""

    done, _pending = await asyncio.wait({task}, timeout=timeout_seconds)
    if not done:
        raise TimeoutError("Async stream cleanup exceeded its bounded close timeout.")
    return task.result()


async def _cancel_task_bounded(task: asyncio.Future[Any]) -> None:
    """Request cancellation and observe a responsive task for one short tick.

    A provider that suppresses cancellation may remain pending; we never
    await it indefinitely. Its done callback still observes a later result.
    """

    if task.done():
        _observe_task_result(task)
        return
    task.cancel()
    done, _pending = await asyncio.wait(
        {task},
        timeout=ASYNC_CLEANUP_CANCEL_GRACE_SECONDS,
    )
    if done:
        _observe_task_result(task)


def _observe_task_result(task: asyncio.Future[Any]) -> None:
    """Consume a detached cleanup task's eventual result safely."""

    if task.cancelled():
        return
    try:
        task.result()
    except BaseException:
        return


class AsyncChatGPTRunner:
    def __init__(
        self,
        backend: Any,
        execution: _AsyncExecution,
        *,
        stream_close_timeout_seconds: float = DEFAULT_ASYNC_STREAM_CLOSE_TIMEOUT_SECONDS,
    ) -> None:
        self._backend = backend
        self._execution = execution
        self._stream_close_timeout_seconds = stream_close_timeout_seconds

    async def _run_transactional(
        self,
        agent: Agent,
        input: Any,
        *,
        operation_id: str | None,
        options: dict[str, Any],
    ) -> ChatGPTRunResult:
        self._execution.assert_backend_open()
        token = _ACTIVE_ASYNC_EXECUTION.set(self._execution)
        try:
            return await run_transactional_async(
                self._backend,
                agent,
                input,
                operation_id=operation_id,
                options=options,
            )
        finally:
            _ACTIVE_ASYNC_EXECUTION.reset(token)

    async def run(
        self,
        agent: Agent,
        input: Any,
        *,
        operation_id: str | None = None,
        **operation_options: Any,
    ) -> ChatGPTRunResult:
        if operation_id is not None:
            return await self._run_transactional(
                agent,
                input,
                operation_id=operation_id,
                options=operation_options,
            )
        try:
            embedded_operation_id = _operation_id_from_input(input)
        except TransactionalInputError as error:
            return _unsupported_run_result(agent, operation_id, error)
        except Exception:
            return _unsupported_run_result(
                agent,
                operation_id,
                TransactionalInputError(_UNSAFE_FIELD_MARKER, "runner input could not be read safely."),
            )
        if embedded_operation_id is not None:
            return await self._run_transactional(
                agent,
                input,
                operation_id=operation_id,
                options=operation_options,
            )
        runner_run = getattr(self._backend, "runner_run", None)
        if callable(runner_run):
            result = await invoke_backend(runner_run, agent.to_wire(), input, execution=self._execution)
            if not isinstance(result, dict):
                raise RuntimeError("runner.run backend result must be a JSON object.")
            return ChatGPTRunResult.from_wire(result)

        request = getattr(self._backend, "request", None)
        if callable(request):
            result = await async_request_backend(
                self._backend,
                "runner.run",
                {"agent": agent.to_wire(), "input": input},
                execution=self._execution,
            )
            if not isinstance(result, dict):
                raise RuntimeError("runner.run backend result must be a JSON object.")
            return ChatGPTRunResult.from_wire(result)

        legacy_run = getattr(self._backend, "run", None)
        if not callable(legacy_run):
            raise RuntimeError("This ChatGPT backend does not support runner.run.")
        payload = {
            "schemaVersion": "chatgpt.browser_control.run.v1",
            "agent": agent.to_wire(),
            "input": input,
        }
        return ChatGPTRunResult.from_wire(await invoke_backend(legacy_run, payload, execution=self._execution))

    async def plan(self, agent: Agent, input: Any) -> SequencePlan:
        runner_plan = getattr(self._backend, "runner_plan", None)
        if callable(runner_plan):
            result = await invoke_backend(runner_plan, agent.to_wire(), input, execution=self._execution)
        else:
            result = await async_request_backend(
                self._backend,
                "runner.plan",
                {"agent": agent.to_wire(), "input": input},
                execution=self._execution,
            )
        if not isinstance(result, dict):
            raise RuntimeError("runner.plan backend result must be a JSON object.")
        return SequencePlan.from_wire(result)

    def run_streamed(self, agent: Agent, input: Any) -> "AsyncRunResultStreaming":
        runner_stream = getattr(self._backend, "runner_stream", None)
        if callable(runner_stream):
            async def load_events() -> Any:
                return await invoke_backend(runner_stream, agent.to_wire(), input, execution=self._execution)
        else:
            stream = getattr(self._backend, "stream", None)
            if not callable(stream):
                raise RuntimeError("This ChatGPT backend does not support runner.stream.")
            async def load_events() -> Any:
                return await invoke_backend(
                    stream,
                    "runner.stream",
                    {"agent": agent.to_wire(), "input": input},
                    execution=self._execution,
                )
        return AsyncRunResultStreaming(
            _events_factory=load_events,
            _execution=self._execution,
            close_timeout_seconds=self._stream_close_timeout_seconds,
        )


@dataclass
class AsyncRunResultStreaming:
    """Async adapter for sync/async event sources with bounded cleanup.

    Sync work runs in daemon-owned pools, so a blocked Python call can be
    detached at shutdown. Async provider cleanup remains loop-affine: a
    coroutine that suppresses cancellation is tracked and cannot be forcibly
    terminated by Python; callers must eventually let that provider cooperate
    for the task and lifecycle lease to retire.
    """

    _events: Any = None
    final_result: ChatGPTRunResult | None = None
    _iterator: Iterator[Any] | None = None
    _events_factory: Callable[[], Awaitable[Any]] | None = None
    _closed: bool = False
    _completed: bool = False
    _events_factory_task: asyncio.Future[Any] | None = None
    _pending_events: list[Any] = field(default_factory=list)
    _pending_close_task: asyncio.Task[None] | None = None
    _close_task: asyncio.Task[Any] | None = None
    _execution: _AsyncExecution | None = None
    close_timeout_seconds: float = DEFAULT_ASYNC_STREAM_CLOSE_TIMEOUT_SECONDS
    _close_source_tasks: dict[int, asyncio.Task[Any]] = field(default_factory=dict)
    _close_source_modes: dict[int, str] = field(default_factory=dict)
    _closed_source_ids: set[int] = field(default_factory=set)
    _stream_acquired: bool = field(init=False, default=False)
    _owns_execution: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        _validate_timeout_seconds(self.close_timeout_seconds, name="close_timeout_seconds")
        if self._execution is None:
            self._execution = _AsyncExecution(
                backend_workers=1,
                stream_workers=4,
                cleanup_workers=2,
            )
            self._owns_execution = True
        assert self._execution is not None
        self._execution.acquire_stream()
        self._stream_acquired = True

    def __aiter__(self) -> "AsyncRunResultStreaming":
        return self

    async def __anext__(self) -> BackendEvent:
        if self._closed or self._completed:
            await self.aclose()
            raise StopAsyncIteration
        try:
            if self._events is None:
                if self._events_factory is None:
                    raise RuntimeError("Async stream has no event source.")
                factory_task = self._ensure_events_factory_task()
                events = await asyncio.shield(factory_task)
                if self._closed:
                    raise StopAsyncIteration
                self._events = events
            if hasattr(self._events, "__anext__"):
                raw = await self._events.__anext__()
            else:
                assert self._execution is not None
                if self._iterator is None:
                    self._iterator = await self._execution.run_stream(iter, self._events)
                ended, raw = await self._execution.run_stream(_next_or_end, self._iterator)
                if ended:
                    await self.aclose()
                    raise StopAsyncIteration
        except StopAsyncIteration:
            try:
                await self.aclose()
            except BaseException:
                # Preserve the iterator's terminal signal. Explicit aclose()
                # remains available to observe/retry provider cleanup.
                pass
            raise
        except asyncio.CancelledError:
            try:
                await self.aclose()
            except BaseException:
                pass
            raise
        except Exception:
            try:
                await self.aclose()
            except BaseException:
                pass
            raise
        try:
            event = BackendEvent.from_wire(raw)
        except Exception:
            try:
                await self.aclose()
            except BaseException:
                pass
            raise
        if event.type == "completed" and isinstance(event.result, ChatGPTRunResult):
            self.final_result = event.result
            self._completed = True
            # The terminal event is the last record this route can produce.
            # Close immediately so callers are not required to request one
            # extra item merely to release a broker route.
            await self.aclose()
        return event

    async def aclose(self) -> None:
        current_task = asyncio.current_task()
        # A concurrent iterator may observe the terminal state while the
        # owner is still finishing cleanup. Waiting for that owner can form a
        # cycle when the owner is itself awaiting the iterator task. There is
        # no active source left for this caller to close in this branch.
        if self._closed and self._events is None and self._iterator is None and not self._pending_events:
            self._maybe_release_execution()
            return
        if self._close_task is not None and self._close_task is not current_task:
            await _await_task_bounded(self._close_task, self.close_timeout_seconds)

        # Mark closure before awaiting user-provided cleanup. A factory that
        # finishes while cleanup is in flight must hand its source to the
        # pending list instead of adopting it as an active source. If cleanup
        # fails, this flag is reset below so callers can retry.
        if current_task is not None:
            self._close_task = current_task
        self._closed = True
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.close_timeout_seconds
        active_events = self._events
        iterator = self._iterator
        self._events = None
        self._iterator = None
        try:
            if active_events is not None:
                await self._close_events(active_events, iterator, deadline)
            elif iterator is not None:
                await self._close_events(iterator, None, deadline)

            while self._pending_events:
                pending_source = self._pending_events.pop(0)
                try:
                    await self._close_events(pending_source, None, deadline)
                except BaseException:
                    self._pending_events.insert(0, pending_source)
                    raise
        finally:
            if self._events is None and active_events is not None and id(active_events) not in self._closed_source_ids:
                self._events = active_events
            if self._iterator is None and iterator is not None and id(iterator) not in self._closed_source_ids:
                self._iterator = iterator
            if self._events is not None or self._iterator is not None or self._pending_events:
                self._closed = False
            if self._close_task is current_task:
                self._close_task = None
            self._maybe_release_execution()

    async def _close_events(self, events: Any, iterator: Any, deadline: float) -> None:
        sources: list[Any] = []
        if iterator is not None:
            sources.append(iterator)
        if events is not None and all(events is not source for source in sources):
            sources.append(events)
        for source in sources:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("Async stream cleanup exceeded its bounded close timeout.")
            await self._close_source(source, remaining)

    async def _close_source(self, source: Any, timeout_seconds: float) -> None:
        source_id = id(source)
        if source_id in self._closed_source_ids:
            return
        task = self._close_source_tasks.get(source_id)
        if task is None:
            self._close_source_modes[source_id] = self._initial_source_close_mode(source)
            task = asyncio.create_task(self._perform_close(source))
            task.add_done_callback(
                lambda completed: self._close_source_done(source_id, source, completed)
            )
            task.add_done_callback(_observe_task_result)
            self._close_source_tasks[source_id] = task
        done, _pending = await asyncio.wait({task}, timeout=timeout_seconds)
        if not done:
            # A responsive async closer is retired promptly. A provider that
            # suppresses cancellation can remain tracked until it cooperates;
            # synchronous cleanup is left tracked too because cancelling its
            # await would otherwise permit a second close while its daemon
            # worker is still executing. We never await either beyond the
            # close bound or start a second close concurrently.
            if self._source_close_is_async(source):
                await _cancel_task_bounded(task)
            raise TimeoutError("Async stream provider cleanup exceeded its bounded close timeout.")
        try:
            task.result()
        finally:
            self._close_source_tasks.pop(source_id, None)
            if task.done() and not task.cancelled():
                self._close_source_modes.pop(source_id, None)
        self._closed_source_ids.add(source_id)

    def _close_source_done(
        self,
        source_id: int,
        source: Any,
        task: asyncio.Future[Any],
    ) -> None:
        if self._close_source_tasks.get(source_id) is not task:
            return
        self._close_source_tasks.pop(source_id, None)
        if task.cancelled():
            self._close_source_modes.pop(source_id, None)
            return
        try:
            task.result()
        except BaseException:
            self._close_source_modes.pop(source_id, None)
            return
        self._closed_source_ids.add(source_id)
        self._close_source_modes.pop(source_id, None)
        self._pending_events = [
            pending for pending in self._pending_events if pending is not source
        ]
        if self._events is source:
            self._events = None
        if self._iterator is source:
            self._iterator = None
        if self._events is None and self._iterator is None and not self._pending_events:
            self._closed = True
        self._maybe_release_execution()

    def _source_close_is_async(self, source: Any) -> bool:
        mode = self._close_source_modes.get(id(source))
        if mode == "async":
            return True
        close_async = getattr(source, "aclose", None)
        return callable(close_async) and inspect.iscoroutinefunction(close_async)

    def _initial_source_close_mode(self, source: Any) -> str:
        close_async = getattr(source, "aclose", None)
        if callable(close_async) and inspect.iscoroutinefunction(close_async):
            return "async"
        return "unknown"

    async def _perform_close(self, events: Any) -> None:
        assert self._execution is not None
        close_async = getattr(events, "aclose", None)
        if callable(close_async):
            if inspect.iscoroutinefunction(close_async):
                self._close_source_modes[id(events)] = "async"
                await close_async()
            else:
                result = await self._execution.run_cleanup(close_async)
                if inspect.isawaitable(result):
                    self._close_source_modes[id(events)] = "async"
                    await result
                else:
                    self._close_source_modes[id(events)] = "sync"
            return
        close = getattr(events, "close", None)
        if callable(close):
            result = await self._execution.run_cleanup(close)
            if inspect.isawaitable(result):
                self._close_source_modes[id(events)] = "async"
                await result
            else:
                self._close_source_modes[id(events)] = "sync"

    def _maybe_release_execution(self) -> None:
        if not self._stream_acquired:
            return
        if not self._closed or self._events is not None or self._iterator is not None:
            return
        if self._events_factory_task is not None:
            return
        if self._pending_events or self._close_source_tasks:
            return
        if self._pending_close_task is not None and not self._pending_close_task.done():
            return
        self._stream_acquired = False
        assert self._execution is not None
        self._execution.release_stream()
        if self._owns_execution:
            self._execution.close()

    def _ensure_events_factory_task(self) -> asyncio.Future[Any]:
        if self._events_factory_task is not None:
            return self._events_factory_task
        if self._events_factory is None:
            raise RuntimeError("Async stream has no event source.")
        # Keep the factory task alive when the consumer is cancelled. This is
        # essential for synchronous factories running in a worker thread: the
        # thread may create a source after the awaiting task has been cancelled.
        factory_task = asyncio.ensure_future(maybe_await(self._events_factory()))
        self._events_factory_task = factory_task
        factory_task.add_done_callback(self._events_factory_finished)
        return factory_task

    def _events_factory_finished(self, factory_task: asyncio.Future[Any]) -> None:
        if self._events_factory_task is factory_task:
            self._events_factory_task = None
        if factory_task.cancelled():
            self._maybe_release_execution()
            return
        try:
            events = factory_task.result()
        except BaseException:
            # Retrieving the exception here prevents a late factory failure
            # from becoming an unhandled task exception after cancellation.
            self._maybe_release_execution()
            return
        if self._events is None and not self._closed:
            self._events = events
            return
        self._pending_events.append(events)
        self._schedule_pending_close()
        self._maybe_release_execution()

    def _schedule_pending_close(self) -> None:
        if self._pending_close_task is not None and not self._pending_close_task.done():
            return
        try:
            self._pending_close_task = asyncio.create_task(self._close_pending_events())
        except RuntimeError:
            # The event loop may already be shutting down. Keep the source in
            # the pending list so an explicit aclose() can still retry it.
            self._pending_close_task = None

    async def _close_pending_events(self) -> None:
        try:
            await self.aclose()
        except BaseException:
            # A close failure remains represented by _pending_events and can
            # be retried by the caller. Never leave an unobserved task error.
            return
        finally:
            self._maybe_release_execution()

    async def __aenter__(self) -> "AsyncRunResultStreaming":
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        await self.aclose()


def _next_or_end(iterator: Iterator[Any]) -> tuple[bool, Any]:
    try:
        return False, next(iterator)
    except StopIteration:
        return True, None


class AsyncResponsesClient:
    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        self._backend = backend
        self._execution = execution

    async def create(self, args: Mapping[Any, Any] | None = None, **kwargs: Any) -> ChatGPTResponse:
        payload = normalize_create_args(_merge_create_args(args, kwargs))
        validation = validate_responses_create_args(payload)
        now = datetime.now(timezone.utc)
        if not validation.ok:
            return unsupported_response(validation.unsupported, now, payload.get("operationId"))

        operation_id = payload.get("operationId")
        if operation_id is not None:
            self._execution.assert_backend_open()
            instructions = payload.get("instructions") if isinstance(payload.get("instructions"), str) else None
            agent = Agent(
                name="responses-adapter",
                instructions=instructions,
                instructions_mode="visible_prefix",
            )
            token = _ACTIVE_ASYNC_EXECUTION.set(self._execution)
            try:
                result = await run_transactional_async(
                    self._backend,
                    agent,
                    responses_create_args_to_run_input(payload),
                    operation_id=operation_id,
                )
            finally:
                _ACTIVE_ASYNC_EXECUTION.reset(token)
            return response_from_run_result(result, now)

        request = getattr(self._backend, "request", None)
        if callable(request):
            result = await async_request_backend(self._backend, "responses.create", payload, execution=self._execution)
            if not isinstance(result, dict):
                raise RuntimeError("responses.create backend result must be a JSON object.")
            return ChatGPTResponse.from_wire(result)

        responses_create = getattr(self._backend, "responses_create", None)
        if callable(responses_create):
            result = await invoke_backend(responses_create, payload, execution=self._execution)
            if not isinstance(result, dict):
                raise RuntimeError("responses.create backend result must be a JSON object.")
            return ChatGPTResponse.from_wire(result)

        legacy_run = getattr(self._backend, "run", None)
        if not callable(legacy_run):
            raise RuntimeError("This ChatGPT backend does not support responses.create.")
        agent = Agent(
            name="responses-adapter",
            instructions=payload.get("instructions") if isinstance(payload.get("instructions"), str) else None,
            instructions_mode=payload.get("instructionsMode", "visible_prefix"),  # type: ignore[arg-type]
        )
        result = await invoke_backend(legacy_run, {
            "schemaVersion": "chatgpt.browser_control.run.v1",
            "agent": agent.to_wire(),
            "input": responses_create_args_to_run_input(payload),
        }, execution=self._execution)
        return response_from_run_result(ChatGPTRunResult.from_wire(result), now)


class AsyncWorkflowClient:
    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        self._backend = backend
        self._execution = execution

    async def ask(self, **kwargs: Any) -> CommandResult:
        return await async_command_result(self._backend, "ask", wire_kwargs(**kwargs), execution=self._execution)

    async def ask_in_thread(self, **kwargs: Any) -> CommandResult:
        return await async_command_result(self._backend, "askInThread", wire_kwargs(**kwargs), execution=self._execution)

    async def ask_with_files(self, **kwargs: Any) -> CommandResult:
        return await async_command_result(self._backend, "askWithFiles", wire_kwargs(**kwargs), execution=self._execution)

    async def ask_and_download(self, **kwargs: Any) -> CommandResult:
        return await async_command_result(self._backend, "askAndDownload", wire_kwargs(**kwargs), execution=self._execution)

    async def run_messages(self, **kwargs: Any) -> CommandResult:
        return command_result_from_wire(await async_request_backend(self._backend, "runMessages", wire_kwargs(**kwargs), execution=self._execution), "runMessages")

    async def open_thread(self, thread: dict[str, Any]) -> CommandResult:
        return command_result_from_wire(await async_request_backend(self._backend, "openThread", thread, execution=self._execution), "openThread")

    async def read_latest(self, **kwargs: Any) -> CommandResult:
        return command_result_from_wire(await async_request_backend(self._backend, "readLatest", wire_kwargs(**kwargs), execution=self._execution), "readLatest")

    async def copy_latest(self, **kwargs: Any) -> CommandResult:
        return command_result_from_wire(await async_request_backend(self._backend, "copyLatest", wire_kwargs(**kwargs), execution=self._execution), "copyLatest")

    async def download_latest(self, **kwargs: Any) -> CommandResult:
        return command_result_from_wire(await async_request_backend(self._backend, "downloadLatest", wire_kwargs(**kwargs), execution=self._execution), "downloadLatest")

    async def run_plan(self, plan: dict[str, Any]) -> CommandResult:
        return command_result_from_wire(await async_request_backend(self._backend, "runPlan", plan, execution=self._execution), "runPlan")

    async def doctor(self, **kwargs: Any) -> CommandResult:
        result = command_result_from_wire(
            await async_request_backend(
                self._backend,
                "doctor",
                wire_kwargs(**kwargs),
                execution=self._execution,
            ),
            "doctor",
        )
        return _attach_doctor_compatibility(result, self._backend, kwargs)

    async def create_report(self, result: dict[str, Any], **kwargs: Any) -> CommandResult:
        payload: dict[str, Any] = {"result": result}
        args = wire_kwargs(**kwargs)
        if args:
            payload["args"] = args
        return command_result_from_wire(await async_request_backend(self._backend, "createReport", payload, execution=self._execution), "createReport")


class AsyncCommandClient:
    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        self._backend = backend
        self._execution = execution

    async def commands(self, *, layer: str | None = None) -> list[CommandDescriptor]:
        payload: dict[str, Any] = {}
        if layer is not None:
            payload["filter"] = {"layer": layer}
        result = await async_request_backend(self._backend, "commands", payload, execution=self._execution)
        if not isinstance(result, list):
            raise RuntimeError("commands backend result must be a list.")
        return [CommandDescriptor.from_wire(item) for item in result]

    async def describe(self, name: str) -> CommandDescriptor:
        result = await async_request_backend(self._backend, "describe", {"name": name}, execution=self._execution)
        if not isinstance(result, dict):
            raise RuntimeError("describe backend result must be a command descriptor.")
        return CommandDescriptor.from_wire(result)

    async def help(self, topic: str | None = None) -> str:
        payload = {} if topic is None else {"topic": topic}
        result = await async_request_backend(self._backend, "help", payload, execution=self._execution)
        if not isinstance(result, str):
            raise RuntimeError("help backend result must be a string.")
        return result


class AsyncReportsClient:
    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        self._backend = backend
        self._execution = execution

    async def create(self, result: dict[str, Any], **kwargs: Any) -> CommandResult:
        return await async_report_command(self._backend, "reports.create", {"result": result}, execution=self._execution, **kwargs)

    async def redact(self, value: Any, **kwargs: Any) -> CommandResult:
        return await async_report_command(self._backend, "reports.redact", {"value": value}, execution=self._execution, **kwargs)

    async def summarize(self, result: dict[str, Any], **kwargs: Any) -> CommandResult:
        return await async_report_command(self._backend, "reports.summarize", {"result": result}, execution=self._execution, **kwargs)


async def async_report_command(
    backend: Any,
    command: str,
    payload: dict[str, Any],
    *,
    execution: _AsyncExecution | None = None,
    **kwargs: Any,
) -> CommandResult:
    args = wire_kwargs(**kwargs)
    if args:
        payload["args"] = args
    return command_result_from_wire(await async_request_backend(backend, command, payload, execution=execution), command)


class AsyncPrimitiveGroup:
    def __init__(self, backend: Any, commands: dict[str, str], execution: _AsyncExecution) -> None:
        self._backend = backend
        self._commands = commands
        self._execution = execution

    def __getattr__(self, name: str):
        command = self._commands.get(name)
        if command is None:
            raise AttributeError(name)

        async def call(**kwargs: Any) -> CommandResult:
            return await async_command_result(
                self._backend,
                command,
                wire_kwargs(**kwargs),
                execution=self._execution,
            )

        return call


class AsyncProjectsClient:
    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        self.sources = AsyncPrimitiveGroup(backend, {
            "list": "projects.sources.list",
            "plan_add": "projects.sources.planAdd",
            "add": "projects.sources.add",
        }, execution)


class AsyncWorkClient(AsyncPrimitiveGroup):
    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        super().__init__(backend, {
            "start": "work.start",
            "status": "work.status",
            "wait": "work.wait",
            "steer": "work.steer",
            "read_latest": "work.readLatest",
        }, execution)
        self.artifacts = AsyncPrimitiveGroup(backend, {
            "list_latest": "artifacts.listLatest",
            "wait": "artifacts.wait",
            "download_latest": "artifacts.downloadLatest",
        }, execution)


@dataclass
class _BackendCloseInvocation:
    """State shared by the bounded backend-close task and its retry logic."""

    sync_started: bool = False
    awaitable_returned: bool = False


async def _invoke_backend_close(
    close_backend: Callable[..., Any],
    execution: _AsyncExecution,
    state: _BackendCloseInvocation,
) -> Any:
    """Invoke a close callable once, keeping awaitables on the owning loop."""

    if inspect.iscoroutinefunction(close_backend):
        state.awaitable_returned = True
        token = _ACTIVE_ASYNC_EXECUTION.set(execution)
        try:
            return await close_backend()
        finally:
            _ACTIVE_ASYNC_EXECUTION.reset(token)

    # A synchronous callable is isolated in the owned cleanup pool.  It may
    # return an awaitable even though the callable itself is not declared
    # ``async``; that awaitable must be resumed on this event loop and becomes
    # cancelable at the caller-facing close bound.
    state.sync_started = True
    result = await execution.run_cleanup(close_backend)
    if inspect.isawaitable(result):
        state.awaitable_returned = True
        token = _ACTIVE_ASYNC_EXECUTION.set(execution)
        try:
            return await result
        finally:
            _ACTIVE_ASYNC_EXECUTION.reset(token)
    return result


class _BoundAsyncOperationsClient(AsyncOperationsClient):
    """Keep direct ``chatgpt.operations`` calls on the owning executor."""

    def __init__(self, backend: Any, execution: _AsyncExecution) -> None:
        super().__init__(backend)
        self._execution = execution

    async def _request(self, command: str, payload: dict[str, Any]) -> Any:
        token = _ACTIVE_ASYNC_EXECUTION.set(self._execution)
        try:
            return await super()._request(command, payload)
        finally:
            _ACTIVE_ASYNC_EXECUTION.reset(token)


class AsyncChatGPT:
    def __init__(
        self,
        transport: Any,
        *,
        backend_workers: int = DEFAULT_ASYNC_BACKEND_WORKERS,
        stream_workers: int = DEFAULT_ASYNC_STREAM_WORKERS,
        cleanup_workers: int = DEFAULT_ASYNC_CLEANUP_WORKERS,
        stream_close_timeout_seconds: float = DEFAULT_ASYNC_STREAM_CLOSE_TIMEOUT_SECONDS,
        close_timeout_seconds: float = DEFAULT_ASYNC_CLIENT_CLOSE_TIMEOUT_SECONDS,
    ) -> None:
        _validate_timeout_seconds(
            stream_close_timeout_seconds,
            name="stream_close_timeout_seconds",
        )
        _validate_timeout_seconds(close_timeout_seconds, name="close_timeout_seconds")
        self._backend = transport
        self._execution = _AsyncExecution(
            backend_workers=backend_workers,
            stream_workers=stream_workers,
            cleanup_workers=cleanup_workers,
        )
        self._stream_close_timeout_seconds = stream_close_timeout_seconds
        self._close_timeout_seconds = close_timeout_seconds
        self._close_requested = False
        self._close_complete = False
        self._closed = False
        self._backend_close_task: asyncio.Task[Any] | None = None
        self._backend_close_invocation: _BackendCloseInvocation | None = None
        self.responses = AsyncResponsesClient(transport, self._execution)
        self.runner = AsyncChatGPTRunner(
            transport,
            self._execution,
            stream_close_timeout_seconds=stream_close_timeout_seconds,
        )
        self._workflows = AsyncWorkflowClient(transport, self._execution)
        self._commands = AsyncCommandClient(transport, self._execution)
        self.session = AsyncPrimitiveGroup(transport, {"bootstrap": "session.bootstrap"}, self._execution)
        self.experience = AsyncPrimitiveGroup(transport, {
            "detect": "experience.detect",
            "open": "experience.open",
        }, self._execution)
        self.configuration = AsyncPrimitiveGroup(transport, {
            "inspect": "configuration.inspect",
            "apply": "configuration.apply",
        }, self._execution)
        self.work = AsyncWorkClient(transport, self._execution)
        self.threads = AsyncPrimitiveGroup(transport, {"new": "threads.new", "search": "threads.search", "open": "threads.open"}, self._execution)
        self.messages = AsyncPrimitiveGroup(transport, {
            "compose": "messages.compose",
            "submit": "messages.submit",
            "ask": "messages.ask",
            "wait": "messages.wait",
            "read_latest": "messages.readLatest",
            "status": "messages.status",
            "stop": "messages.stop",
            "wait_and_read": "messages.waitAndRead",
        }, self._execution)
        self.files = AsyncPrimitiveGroup(transport, {"preflight": "files.preflight", "attach": "files.attach", "download_latest": "files.downloadLatest"}, self._execution)
        self.projects = AsyncProjectsClient(transport, self._execution)
        self.artifacts = AsyncPrimitiveGroup(transport, {
            "list_latest": "artifacts.listLatest",
            "wait": "artifacts.wait",
            "download_latest": "artifacts.downloadLatest",
        }, self._execution)
        self.modes = AsyncPrimitiveGroup(transport, {"set": "modes.set", "get": "modes.get"}, self._execution)
        self.tools = AsyncPrimitiveGroup(transport, {"select": "tools.select"}, self._execution)
        self.response = AsyncPrimitiveGroup(transport, {"copy": "response.copy"}, self._execution)
        self.reports = AsyncReportsClient(transport, self._execution)
        self.operations = _BoundAsyncOperationsClient(transport, self._execution)

    def _mark_close_complete(self) -> None:
        if self._close_complete:
            return
        self._close_complete = True
        self._closed = True
        self._execution.close()

    def _backend_close_done(self, task: asyncio.Future[Any]) -> None:
        if self._backend_close_task is not task:
            return
        if task.cancelled():
            self._backend_close_task = None
            self._backend_close_invocation = None
            return
        try:
            task.result()
        except BaseException:
            self._backend_close_task = None
            self._backend_close_invocation = None
            return
        self._backend_close_invocation = None
        self._mark_close_complete()

    async def aclose(self) -> None:
        """Close the backend with a bounded caller-facing wait.

        A synchronous close that is already running in the daemon cleanup
        pool cannot be force-stopped; later callers share its one in-flight
        task until it finishes. An async closer is cancellation-requested at
        the bound, but a coroutine that suppresses cancellation remains
        loop-affine and pending until its provider cooperates. In either case
        a timed-out close is not reported as complete, so an explicit retry
        can finish cleanup without starting a duplicate close.
        """
        if self._close_complete:
            return
        self._close_requested = True
        # Fence backend admission before inspecting or awaiting the provider
        # close. Existing streams and cleanup pools remain usable until their
        # leases are released, while every fresh backend route is rejected.
        self._execution.request_close()
        close_backend = getattr(self._backend, "close", None)
        if not callable(close_backend):
            self._mark_close_complete()
            return

        task = self._backend_close_task
        if task is None:
            invocation = _BackendCloseInvocation()
            self._backend_close_invocation = invocation
            task = asyncio.create_task(
                _invoke_backend_close(close_backend, self._execution, invocation)
            )
            self._backend_close_task = task
            task.add_done_callback(self._backend_close_done)
            task.add_done_callback(_observe_task_result)
        try:
            await _await_task_bounded(task, self._close_timeout_seconds)
        except (asyncio.CancelledError, TimeoutError):
            # Async closers can be cancelled and retried once the cancelled
            # task retires. A synchronous close runs in a daemon worker; its
            # await wrapper cannot be cancelled without risking a concurrent
            # second close while that worker is still executing.
            invocation = self._backend_close_invocation
            if invocation is not None and (
                not invocation.sync_started or invocation.awaitable_returned
            ):
                await _cancel_task_bounded(task)
                if task.done() and self._backend_close_task is task and task.cancelled():
                    self._backend_close_task = None
                    self._backend_close_invocation = None
            raise
        except BaseException:
            if task.done() and self._backend_close_task is task:
                self._backend_close_task = None
                self._backend_close_invocation = None
            raise
        self._mark_close_complete()

    async def run(
        self,
        agent: Agent,
        input: Any,
        *,
        operation_id: str | None = None,
        **operation_options: Any,
    ) -> ChatGPTRunResult:
        return await self.runner.run(agent, input, operation_id=operation_id, **operation_options)

    async def ask(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.ask(**kwargs)

    async def ask_in_thread(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.ask_in_thread(**kwargs)

    async def ask_with_files(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.ask_with_files(**kwargs)

    async def ask_and_download(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.ask_and_download(**kwargs)

    async def run_messages(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.run_messages(**kwargs)

    async def open_thread(self, thread: dict[str, Any]) -> CommandResult:
        return await self._workflows.open_thread(thread)

    async def read_latest(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.read_latest(**kwargs)

    async def copy_latest(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.copy_latest(**kwargs)

    async def download_latest(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.download_latest(**kwargs)

    async def run_plan(self, plan: dict[str, Any]) -> CommandResult:
        return await self._workflows.run_plan(plan)

    async def doctor(self, **kwargs: Any) -> CommandResult:
        return await self._workflows.doctor(**kwargs)

    async def create_report(self, result: dict[str, Any], **kwargs: Any) -> CommandResult:
        return await self._workflows.create_report(result, **kwargs)

    async def commands(self, *, layer: str | None = None) -> list[CommandDescriptor]:
        return await self._commands.commands(layer=layer)

    async def describe(self, name: str) -> CommandDescriptor:
        return await self._commands.describe(name)

    async def help(self, topic: str | None = None) -> str:
        return await self._commands.help(topic)

    def agent(
        self,
        *,
        name: str,
        instructions: str | None = None,
        instructions_mode: str = "visible_prefix",
        defaults: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        guardrails: list[dict[str, Any]] | None = None,
        output: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Agent:
        return Agent(
            name=name,
            instructions=instructions,
            instructions_mode=instructions_mode,  # type: ignore[arg-type]
            defaults=defaults or {},
            tools=tools or [],
            guardrails=guardrails or [],
            output=output,
            metadata=metadata,
        )
