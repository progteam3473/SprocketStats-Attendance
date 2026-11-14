import { useEffect } from "react"
import { API } from "@/lib/api"

// The server judges a member code against the moment the camera read it, and
// only accepts scan times within a few seconds of its own clock. Keep a
// correction to the laptop's clock, measured against GET /kiosk/clock.
let offsetMs = 0

const RESYNC_MS = 5 * 60 * 1000
// A slow round trip makes the midpoint estimate meaningless; skip those.
const MAX_ROUND_TRIP_MS = 2000

/** Server-corrected Unix time in milliseconds. */
export function serverNow(): number {
    return Date.now() + offsetMs
}

export async function syncServerClock(): Promise<void> {
    const sentAt = Date.now()
    const res = await fetch(`${API}/kiosk/clock`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
    const receivedAt = Date.now()
    if (!res.ok || receivedAt - sentAt > MAX_ROUND_TRIP_MS) return
    const { server_time } = await res.json() as { server_time: number }
    offsetMs = server_time * 1000 - (sentAt + receivedAt) / 2
}

/** Keeps the correction fresh while a scanning screen is up. */
export function useServerClock() {
    useEffect(() => {
        const run = () => void syncServerClock().catch(() => {})
        run()
        const timer = window.setInterval(run, RESYNC_MS)
        return () => window.clearInterval(timer)
    }, [])
}
