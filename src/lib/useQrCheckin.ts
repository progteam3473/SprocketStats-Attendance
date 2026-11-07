import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { ApiError, fetchQrCode, fetchQrScans, type VerifyIdResult } from "@/lib/api"

// A fresh code replaces the last one this often; the backend keeps each valid a
// little longer so a scan right at the swap still lands.
const ROTATE_MS = 15000
const POLL_MS = 1500
// Codes still worth polling for (rotation interval vs the 30s server lifetime).
const MAX_LIVE_CODES = 3

/**
 * Keeps a rotating one-time QR code on screen and reports each member who
 * claims one with their phone. Returns the QR as an image data URL (null until
 * the first code arrives or while the server is unreachable).
 */
export function useQrCheckin(
    onScan: (scan: VerifyIdResult & { token: string }) => void,
    onDeauthorized: () => void,
): string | null {
    const [image, setImage] = useState<string | null>(null)
    const live = useRef<string[]>([])
    // Latest callbacks without restarting the timers.
    const handlers = useRef({ onScan, onDeauthorized })
    useEffect(() => { handlers.current = { onScan, onDeauthorized } })

    useEffect(() => {
        let cancelled = false
        let rotateTimer = 0

        async function rotate() {
            window.clearTimeout(rotateTimer)
            try {
                const code = await fetchQrCode()
                const dataUrl = await QRCode.toDataURL(code.url, { margin: 2, width: 320, errorCorrectionLevel: "M" })
                if (cancelled) return
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
            if (!cancelled) rotateTimer = window.setTimeout(() => void rotate(), ROTATE_MS)
        }

        async function poll() {
            if (live.current.length === 0) return
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

        void rotate()
        const pollTimer = window.setInterval(() => void poll(), POLL_MS)
        return () => {
            cancelled = true
            window.clearTimeout(rotateTimer)
            window.clearInterval(pollTimer)
        }
    }, [])

    return image
}
