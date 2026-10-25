import { useEffect, useRef } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/** Resolves to whether the backend accepted the scan; drives the reader LED. */
export type ScanHandler = (id: string) => Promise<boolean>

/**
 * Subscribes to card taps from the built-in NFC reader (the Rust side emits
 * `nfc-scan`) and reports each outcome back via `nfc_feedback` so the LED
 * shows green only once the backend has accepted the scan.
 *
 * Pass null on screens that don't take scans: taps are rejected right away
 * instead of leaving the reader waiting for its timeout.
 *
 * Outside Tauri (the web build) this is a no-op; keyboard-wedge readers keep
 * working through each page's focused input instead.
 */
export function useNfcScan(handler: ScanHandler | null) {
    const handlerRef = useRef(handler)
    handlerRef.current = handler

    useEffect(() => {
        if (!isTauri()) return
        let unlisten: (() => void) | undefined
        let cancelled = false
        void listen<string>("nfc-scan", async ({ payload }) => {
            let ok = false
            try {
                ok = (await handlerRef.current?.(payload)) ?? false
            } finally {
                invoke("nfc_feedback", { ok }).catch(() => {})
            }
        }).then((u) => {
            // StrictMode unmounts before listen() resolves; don't leak it.
            if (cancelled) u()
            else unlisten = u
        })
        return () => {
            cancelled = true
            unlisten?.()
        }
    }, [])
}
