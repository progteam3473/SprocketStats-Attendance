import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { ApiError, fetchQrCode, fetchQrScans, type VerifyIdResult } from "@/lib/api"

// A fresh code replaces the last one this often; the backend keeps each valid a
// little longer so a scan right at the swap still lands.
const ROTATE_MS = 15000
const POLL_MS = 4000
// With no click, key, touch or card tap for this long, stop rotating and
// polling so the backend and database can idle. Any activity resumes at once.
const IDLE_MS = 10 * 60 * 1000
// Codes still worth polling for (rotation interval vs the 30s server lifetime).
const MAX_LIVE_CODES = 3

/**
 * Keeps a rotating one-time QR code on screen and reports each member who
 * claims one with their phone. Returns the QR as an image data URL (null until
 * the first code arrives or while the server is unreachable), and whether it
 * is paused for inactivity.
 */
export function useQrCheckin(
    onScan: (scan: VerifyIdResult & { token: string }) => void,
    onDeauthorized: () => void,
): { image: string | null; paused: boolean } {
    const [image, setImage] = useState<string | null>(null)
    const [paused, setPaused] = useState(false)
    const live = useRef<string[]>([])
    // Latest callbacks without restarting the timers.
    const handlers = useRef({ onScan, onDeauthorized })
    useEffect(() => { handlers.current = { onScan, onDeauthorized } })

    useEffect(() => {
        let cancelled = false
        let rotateTimer = 0
        let pollTimer = 0
        let idleTimer = 0
        let idle = false

        async function rotate() {
            window.clearTimeout(rotateTimer)
            try {
                const code = await fetchQrCode()
                const dataUrl = await QRCode.toDataURL(code.url, { margin: 2, width: 320, errorCorrectionLevel: "M" })
                if (cancelled || idle) return
                live.current = [code.token, ...live.current].slice(0, MAX_LIVE_CODES)
                setImage(dataUrl)
            } catch (err) {
                if (cancelled) return
                if (err instanceof ApiError && err.status === 401) {
                    handlers.current.onDeauthorized()
                    return
                }
                // Never show a stale code: it would be dead by the time it's scanned.
                setImage(null)
                live.current = []
            }
            if (!cancelled && !idle) rotateTimer = window.setTimeout(() => void rotate(), ROTATE_MS)
        }

        async function poll() {
            if (idle || live.current.length === 0) return
            try {
                const scans = await fetchQrScans(live.current)
                if (cancelled || scans.length === 0) return
                live.current = live.current.filter(t => !scans.some(s => s.token === t))
                for (const scan of scans) handlers.current.onScan(scan)
                // A used code is dead; swap in a new one immediately.
                void rotate()
            } catch (err) {
                if (err instanceof ApiError && err.status === 401) handlers.current.onDeauthorized()
            }
        }

        function goIdle() {
            idle = true
            window.clearTimeout(rotateTimer)
            window.clearInterval(pollTimer)
            // The shown code would expire while nobody is looking; drop it.
            live.current = []
            setImage(null)
            setPaused(true)
        }

        function onActivity() {
            window.clearTimeout(idleTimer)
            idleTimer = window.setTimeout(goIdle, IDLE_MS)
            if (!idle) return
            idle = false
            setPaused(false)
            pollTimer = window.setInterval(() => void poll(), POLL_MS)
            void rotate()
        }

        const events = ["pointerdown", "keydown", "touchstart"] as const
        for (const e of events) window.addEventListener(e, onActivity, { passive: true })
        // A card tap arrives from the Rust side, not as input.
        let unlisten: (() => void) | undefined
        if (isTauri()) {
            void listen("nfc-scan", onActivity).then((u) => {
                if (cancelled) u()
                else unlisten = u
            })
        }

        idleTimer = window.setTimeout(goIdle, IDLE_MS)
        void rotate()
        pollTimer = window.setInterval(() => void poll(), POLL_MS)
        return () => {
            cancelled = true
            window.clearTimeout(rotateTimer)
            window.clearTimeout(idleTimer)
            window.clearInterval(pollTimer)
            for (const e of events) window.removeEventListener(e, onActivity)
            unlisten?.()
        }
    }, [])

    return { image, paused }
}
