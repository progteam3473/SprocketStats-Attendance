import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { API, ApiError, fetchQrCode, fetchQrScans, type VerifyIdResult } from "@/lib/api"

// A fresh code replaces the last one this often; the backend keeps each valid a
// little longer so a scan right at the swap still lands.
const ROTATE_MS = 15000
// Fallback poll while the push stream is down; the stream makes claims instant.
const POLL_MS = 1000
// Safety-net poll while the stream is up, in case an event is ever missed.
const SAFETY_POLL_MS = 10000
// Backoff for reopening a stream that closed for good (old backend, 401).
const STREAM_RETRY_MIN_MS = 5000
const STREAM_RETRY_MAX_MS = 5 * 60 * 1000
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
        let retryTimer = 0
        let idle = false
        // Bumped whenever the shown code dies (claimed, idle), so a rotate already
        // in flight from before can't put its now-stale code back on screen.
        let gen = 0
        let stream: EventSource | null = null
        let streamOpen = false
        let retryDelay = STREAM_RETRY_MIN_MS

        async function rotate() {
            window.clearTimeout(rotateTimer)
            const g = gen
            try {
                const code = await fetchQrCode()
                const dataUrl = await QRCode.toDataURL(code.url, { margin: 2, width: 320, errorCorrectionLevel: "M" })
                if (cancelled || idle || g !== gen) return
                live.current = [code.token, ...live.current].slice(0, MAX_LIVE_CODES)
                setImage(dataUrl)
            } catch (err) {
                if (cancelled || g !== gen) return
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

        // Take the code off screen at once; a second scan of it would only get a 410.
        function hideCode() {
            gen++
            setImage(null)
        }

        // Shared by poll and the stream, which can both see the same claim: only
        // tokens still in live are reported, and removing them is the dedupe.
        // Returns how many were new.
        function handleScans(scans: Awaited<ReturnType<typeof fetchQrScans>>): number {
            const fresh = scans.filter(s => live.current.includes(s.token))
            if (fresh.length === 0) return 0
            hideCode()
            live.current = live.current.filter(t => !fresh.some(s => s.token === t))
            for (const scan of fresh) handlers.current.onScan(scan)
            // A used code is dead; swap in a new one immediately.
            if (!idle) void rotate()
            return fresh.length
        }

        function fail(err: unknown) {
            if (err instanceof ApiError && err.status === 401) handlers.current.onDeauthorized()
        }

        async function poll() {
            if (idle || live.current.length === 0) return
            try {
                const scans = await fetchQrScans(live.current)
                if (!cancelled) handleScans(scans)
            } catch (err) {
                fail(err)
            }
        }

        // Fast while the stream is down (or missing), slow safety net while it's up.
        function schedulePoll() {
            window.clearTimeout(pollTimer)
            if (cancelled || idle) return
            pollTimer = window.setTimeout(async () => {
                await poll()
                schedulePoll()
            }, streamOpen ? SAFETY_POLL_MS : POLL_MS)
        }

        async function onClaimed(data: string) {
            let token: unknown
            try {
                token = (JSON.parse(data) as { token?: unknown }).token
            } catch {
                return
            }
            if (typeof token !== "string" || !live.current.includes(token)) return
            hideCode()
            try {
                const scans = await fetchQrScans([token])
                if (cancelled) return
                if (handleScans(scans) > 0) return
            } catch (err) {
                fail(err)
            }
            // Not reported here (already handled, or details not ready): if the
            // token is still live the shown code is gone, so get a new one anyway.
            if (!cancelled && !idle && live.current.includes(token)) void rotate()
        }

        function closeStream() {
            window.clearTimeout(retryTimer)
            stream?.close()
            stream = null
            streamOpen = false
        }

        function openStream() {
            if (typeof EventSource === "undefined" || stream || cancelled || idle) return
            const s = new EventSource(`${API}/kiosk/qr_events`, { withCredentials: true })
            stream = s
            s.onopen = () => {
                if (stream !== s) return
                streamOpen = true
                retryDelay = STREAM_RETRY_MIN_MS
                // A claim made while the stream was down isn't replayed; catch it now.
                void poll().then(schedulePoll)
            }
            s.addEventListener("claimed", (e) => void onClaimed((e as MessageEvent<string>).data))
            s.onerror = () => {
                if (stream !== s) return
                // Fast-poll while it reconnects by itself.
                if (streamOpen) {
                    streamOpen = false
                    schedulePoll()
                }
                // CLOSED means it gave up (404 on an old backend, 401: EventSource
                // can't tell which). Polling covers both and surfaces a 401; retry
                // the stream now and then in case it was a blip.
                if (s.readyState === EventSource.CLOSED) {
                    s.close()
                    stream = null
                    retryTimer = window.setTimeout(openStream, retryDelay)
                    retryDelay = Math.min(retryDelay * 2, STREAM_RETRY_MAX_MS)
                }
            }
        }

        function goIdle() {
            idle = true
            gen++
            window.clearTimeout(rotateTimer)
            window.clearTimeout(pollTimer)
            // An open stream would keep the backend (and Neon) awake.
            closeStream()
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
            retryDelay = STREAM_RETRY_MIN_MS
            openStream()
            schedulePoll()
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
        openStream()
        schedulePoll()
        return () => {
            cancelled = true
            window.clearTimeout(rotateTimer)
            window.clearTimeout(idleTimer)
            window.clearTimeout(pollTimer)
            closeStream()
            for (const e of events) window.removeEventListener(e, onActivity)
            unlisten?.()
        }
    }, [])

    return { image, paused }
}
