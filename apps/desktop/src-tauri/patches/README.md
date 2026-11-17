# Dependency patches

## `wry` 0.57.1 (#356)

Upstream `wry::webview2::main_thread_dispatcher_proc` calls `RedrawWindow(..., RDW_INTERNALPAINT)` after every `Wry::ExecMsg` handler. That posts `WM_PAINT` even when the HWND is clean, which can keep the Tao main event-loop thread at ~100% CPU on Windows at idle.

This patch removes that `RedrawWindow` call. Prefer rebasing onto a crates.io `wry` release that drops or gates it upstream.
