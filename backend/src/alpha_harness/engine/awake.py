"""Keep the machine awake while simulations are pending.

The daily allowance completes over hours, a sleeping machine sends nothing, and quota
unspent by the US-Eastern reset is gone — so while work is pending the OS is asked, with
its own tool, not to sleep. Lid-close sleep is not preventable by these APIs and WSL
cannot reach the Windows host; the Matrix tells the user instead.
"""

import os
import platform
import shutil
import subprocess
import sys
from typing import Literal

import structlog

log = structlog.get_logger(__name__)

AwakeState = Literal["idle", "held", "unavailable"]

_ES_CONTINUOUS = 0x80000000
_ES_SYSTEM_REQUIRED = 0x00000001


def _command() -> list[str] | None:
    """The process that holds the machine awake while it lives, or ``None``."""
    if sys.platform == "darwin":
        return ["caffeinate", "-i", "-w", str(os.getpid())]
    if sys.platform.startswith("linux") and "microsoft" not in platform.release().lower():
        if shutil.which("systemd-inhibit"):
            # ``cat`` on our stdin pipe: if this process is killed the pipe closes, ``cat``
            # exits, and the lock goes with it.
            return [
                "systemd-inhibit",
                "--what=sleep:idle",
                "--who=Alpha Harness",
                "--why=Simulations are pending",
                "cat",
            ]
    return None


class StayAwake:
    """Holds or releases the OS sleep block. Never raises."""

    def __init__(self) -> None:
        self.state: AwakeState = "idle"
        self._proc: subprocess.Popen[bytes] | None = None

    def hold(self, busy: bool) -> None:
        if not busy:
            self.release()
            return
        if self.state == "held" and (self._proc is None or self._proc.poll() is None):
            return
        if self._proc is not None:
            # The inhibitor died while holding (polkit refused it, say): the machine can
            # sleep, so say so rather than report "held". ``release`` clears this once the
            # work drains, so the next busy spell tries again.
            if self.state == "held":
                log.warning("awake.inhibitor_exited", code=self._proc.returncode)
            self.state = "unavailable"
            return
        try:
            if sys.platform == "win32":
                # Thread-bound: always called from the event-loop thread.
                import ctypes

                ok = ctypes.windll.kernel32.SetThreadExecutionState(
                    _ES_CONTINUOUS | _ES_SYSTEM_REQUIRED
                )
                self.state = "held" if ok else "unavailable"
                return
            # Narrowed in the positive branch, not by an early return on None: this is
            # unreachable on Windows, where pyrefly stops refining and reads the declared type.
            cmd = _command()
            if cmd is None:
                self.state = "unavailable"
            else:
                self._proc = subprocess.Popen(  # noqa: S603 - fixed argv, no user input
                    cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                self.state = "held"
        except Exception:
            log.warning("awake.hold_failed", exc_info=True)
            self.state = "unavailable"

    def release(self) -> None:
        try:
            if sys.platform == "win32" and self.state == "held":
                import ctypes

                ctypes.windll.kernel32.SetThreadExecutionState(_ES_CONTINUOUS)
            if self._proc is not None:
                if self._proc.stdin is not None:
                    self._proc.stdin.close()
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
                    self._proc.wait()
        except Exception:
            log.warning("awake.release_failed", exc_info=True)
        self._proc = None
        self.state = "idle"


if __name__ == "__main__":
    awake = StayAwake()
    awake.hold(True)
    held = awake.state
    awake.hold(False)
    if held not in ("held", "unavailable") or awake.state != "idle":
        raise SystemExit(f"awake self-check failed: hold -> {held}, release -> {awake.state}")
    sys.stdout.write(f"hold -> {held}, release -> idle\n")
