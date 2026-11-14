import { useEffect, useRef, useState } from "react"
import { serverNow } from "@/lib/clock"
import type { FoundCode, Point, WorkerRequest, WorkerResponse } from "@/lib/scanWorker"

// 4-digit member code number + 12-digit tag (backend/core/member_codes.py).
// Tracks are keyed by the number, which stays the same as the tag rotates.
const MEMBER_CODE = /^(\d{4})\d{12}$/

// An appearance ends only after this many processed frames without the
// member's code AND this long since it was last seen, so a frame the decoder
// misses (blur, glare) never counts as the phone leaving. Turning the phone
// away and back takes longer than this, and is then a new scan.
const END_MISSED_FRAMES = 10
const END_MS = 800

export type TrackStatus = "checking" | "ok" | "error"

export interface Track {
    codeNumber: string
    quad: Point[]
    status: TrackStatus
    label: string
    /** Read in the latest frame; false while it's briefly lost. */
    visible: boolean
}

export interface AppearanceResult {
    ok: boolean
    label: string
}

interface LiveTrack {
    lastSeen: number
    misses: number
    quad: Point[]
    status: TrackStatus
    label: string
    visible: boolean
}

function center(q: Point[]): Point {
    return { x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length }
}

/** A found-but-unreadable code close enough to a member's last position is them. */
function near(found: Point[], last: Point[]): boolean {
    const a = center(found)
    const b = center(last)
    const size = Math.hypot(last[0].x - last[2].x, last[0].y - last[2].y)
    return Math.hypot(a.x - b.x, a.y - b.y) < size
}

/**
 * Runs the camera and the decoder, and turns frames into per-member
 * appearances: `onAppear` fires once when a member's code first shows up and
 * not again until it has really left the frame. Returns what the preview needs.
 */
export function useCodeScanner(onAppear: (code: string, scannedAt: number) => Promise<AppearanceResult>) {
    const videoRef = useRef<HTMLVideoElement>(null)
    const [tracks, setTracks] = useState<Track[]>([])
    const [videoSize, setVideoSize] = useState<{ width: number, height: number } | null>(null)
    const [cameraError, setCameraError] = useState<string | null>(null)
    const onAppearRef = useRef(onAppear)
    useEffect(() => { onAppearRef.current = onAppear })

    useEffect(() => {
        let cancelled = false
        let stream: MediaStream | null = null
        let frame = 0
        let busy = false
        const live = new Map<string, LiveTrack>()
        const worker = new Worker(new URL("./scanWorker.ts", import.meta.url), { type: "module" })

        const publish = () => setTracks([...live].map(([codeNumber, t]) => ({
            codeNumber, quad: t.quad, status: t.status, label: t.label, visible: t.visible,
        })))

        const handle = (capturedAt: number, codes: FoundCode[]) => {
            const seen = new Set<string>()
            const unreadable: Point[][] = []
            for (const c of codes) {
                if (c.text === null) {
                    unreadable.push(c.quad)
                    continue
                }
                const m = MEMBER_CODE.exec(c.text)
                if (!m) continue // some other Data Matrix
                const codeNumber = m[1]
                seen.add(codeNumber)
                const existing = live.get(codeNumber)
                if (existing) {
                    Object.assign(existing, { lastSeen: capturedAt, misses: 0, quad: c.quad, visible: true })
                    continue
                }
                const track: LiveTrack = {
                    lastSeen: capturedAt, misses: 0, quad: c.quad, status: "checking", label: "Checking…", visible: true,
                }
                live.set(codeNumber, track)
                void onAppearRef.current(c.text, capturedAt).then((r) => {
                    track.status = r.ok ? "ok" : "error"
                    track.label = r.label
                    if (!cancelled) publish()
                })
            }
            for (const [codeNumber, t] of live) {
                if (seen.has(codeNumber)) continue
                if (unreadable.some((q) => near(q, t.quad))) {
                    Object.assign(t, { lastSeen: capturedAt, misses: 0, visible: true })
                    continue
                }
                t.visible = false
                t.misses += 1
                if (t.misses >= END_MISSED_FRAMES && capturedAt - t.lastSeen >= END_MS) live.delete(codeNumber)
            }
            publish()
        }

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
            busy = false
            if (!cancelled) handle(e.data.capturedAt, e.data.codes)
        }

        const grab = async () => {
            const video = videoRef.current
            if (cancelled || !video) return
            if (!busy && video.readyState >= 2 && video.videoWidth > 0) {
                busy = true
                try {
                    const capturedAt = serverNow()
                    const bitmap = await createImageBitmap(video)
                    const message: WorkerRequest = { bitmap, capturedAt }
                    worker.postMessage(message, [bitmap])
                } catch {
                    busy = false
                }
            }
            frame = requestAnimationFrame(() => void grab())
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setCameraError("No camera available")
        } else {
            navigator.mediaDevices.getUserMedia({
                audio: false,
                // Ask for 1080p: a webcam that has it reads codes ~1.5x further
                // away, and a 720p-only one just gives 720p. Asking matters;
                // browsers often default to 640x480.
                video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: "user" },
            }).then(async (s) => {
                if (cancelled) {
                    s.getTracks().forEach((t) => t.stop())
                    return
                }
                stream = s
                const video = videoRef.current
                if (!video) return
                video.srcObject = s
                const size = () => setVideoSize({ width: video.videoWidth || 1280, height: video.videoHeight || 720 })
                video.addEventListener("resize", size)
                await video.play().catch(() => {})
                size()
                frame = requestAnimationFrame(() => void grab())
            }).catch((err: unknown) => {
                if (!cancelled) {
                    setCameraError(err instanceof DOMException && err.name === "NotAllowedError"
                        ? "Camera access was blocked"
                        : "No camera available")
                }
            })
        }

        return () => {
            cancelled = true
            cancelAnimationFrame(frame)
            worker.terminate()
            stream?.getTracks().forEach((t) => t.stop())
        }
    }, [])

    return { videoRef, tracks, videoSize, cameraError }
}
