import type { RefObject } from "react"
import { Check, Loader2, X } from "lucide-react"
import type { Track } from "@/lib/useCodeScanner"

const GREEN = "oklch(0.7 0.15 140)"
const RED = "oklch(0.637 0.237 25.331)"

/** As large as the window allows: up to 1280px wide, leaving room for the top band and footer. */
export const PREVIEW_WIDTH = "min(1280px, 92vw, calc((100vh - 340px) * 16 / 9))"

/**
 * The live camera, mirrored like a selfie camera so moving a phone left moves
 * it left on screen, with an outline and a label on every code being tracked.
 * Decoding uses the unmirrored frames; only the drawing is flipped.
 */
export function CameraPreview({ videoRef, videoSize, tracks, cameraError }: {
    videoRef: RefObject<HTMLVideoElement | null>
    videoSize: { width: number, height: number } | null
    tracks: Track[]
    cameraError: string | null
}) {
    const w = videoSize?.width ?? 1280
    const h = videoSize?.height ?? 720
    return (
        <div
            className="relative shrink-0 overflow-hidden rounded-2xl border bg-black shadow-2xl"
            style={{ width: PREVIEW_WIDTH, aspectRatio: `${w} / ${h}`, borderColor: "var(--theme-border)" }}
        >
            <video
                ref={videoRef}
                muted
                playsInline
                aria-label="Camera"
                className="absolute inset-0 size-full object-cover"
                style={{ transform: "scaleX(-1)" }}
            />
            <svg viewBox={`0 0 ${w} ${h}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
                {tracks.map((t) => (
                    <polygon
                        key={t.codeNumber}
                        points={t.quad.map((p) => `${w - p.x},${p.y}`).join(" ")}
                        fill="none"
                        stroke={t.status === "ok" ? GREEN : t.status === "error" ? RED : "#ffffff"}
                        strokeWidth={Math.max(3, w / 320)}
                        strokeLinejoin="round"
                        opacity={t.visible ? 1 : 0.4}
                    />
                ))}
            </svg>
            {tracks.map((t) => {
                const top = Math.min(...t.quad.map((p) => p.y))
                const cx = w - t.quad.reduce((s, p) => s + p.x, 0) / t.quad.length
                return (
                    <div
                        key={t.codeNumber}
                        className="absolute flex items-center gap-2 whitespace-nowrap rounded-full py-1.5 pl-3 pr-4 text-2xl font-bold transition-opacity"
                        style={{
                            left: `${(cx / w) * 100}%`,
                            top: `${(top / h) * 100}%`,
                            transform: "translate(-50%, calc(-100% - 10px))",
                            background: t.status === "ok" ? GREEN : t.status === "error" ? RED : "rgb(0 0 0 / 0.65)",
                            color: t.status === "ok" ? "#0c1f12" : "#ffffff",
                            opacity: t.visible ? 1 : 0.5,
                        }}
                    >
                        {t.status === "ok" ? <Check size={28} strokeWidth={2.6} />
                            : t.status === "error" ? <X size={28} strokeWidth={2.6} />
                                : <Loader2 size={26} className="animate-spin" />}
                        {t.label}
                    </div>
                )
            })}
            {cameraError && (
                <div className="absolute inset-0 flex items-center justify-center text-xl theme-subtext-color">
                    {cameraError}
                </div>
            )}
        </div>
    )
}
