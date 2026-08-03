import { useEffect, useRef, useState } from "react"
import { CheckCircle2, KeyRound, LogOut, ScanLine, XCircle } from "lucide-react"
import { ApiError, kioskLogout, verifyId, type VerifyIdResult } from "@/lib/api"

const RESULT_DISMISS_MS = 3500

const cardStyle = { background: "var(--theme-bg)", borderColor: "var(--theme-border)" }

type Result =
    | { kind: "success", name: string, status: VerifyIdResult["status"] }
    | { kind: "error", message: string }

export default function KioskPage({ onDeauthorized, onManualCheckin }: {
    onDeauthorized: () => void
    onManualCheckin: () => void
}) {
    const [id, setId] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [result, setResult] = useState<Result | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // RFID readers act as keyboards, so the scan field must always own focus.
    useEffect(() => {
        const refocus = () => inputRef.current?.focus()
        refocus()
        window.addEventListener("click", refocus)
        return () => window.removeEventListener("click", refocus)
    }, [])

    useEffect(() => {
        if (!result) return
        const t = window.setTimeout(() => setResult(null), RESULT_DISMISS_MS)
        return () => window.clearTimeout(t)
    }, [result])

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        const scanned = id.trim()
        setId("")
        if (!scanned || submitting) return
        setSubmitting(true)
        try {
            const { name, status } = await verifyId(scanned)
            setResult({ kind: "success", name, status })
        } catch (err) {
            // The kiosk cookie is gone or expired — send it back through setup.
            if (err instanceof ApiError && err.status === 401) {
                onDeauthorized()
                return
            }
            setResult({ kind: "error", message: err instanceof Error ? err.message : "Scan failed" })
        } finally {
            setSubmitting(false)
            inputRef.current?.focus()
        }
    }

    async function handleDeauthorize() {
        try {
            await kioskLogout()
        } catch {
            // Clearing the cookie failed server-side; still leave kiosk mode locally.
        }
        onDeauthorized()
    }

    return (
        <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-8 gap-6">
            <button
                onClick={onManualCheckin}
                className="absolute top-4 right-4 flex items-center gap-1.5 text-xs theme-subtext-color hover:opacity-70 transition-opacity underline underline-offset-2"
            >
                <KeyRound size={14} />
                Manual check-in
            </button>

            <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-xs font-semibold tracking-widest theme-subtext-color">SPROCKETSTATS</p>
                <h1 className="text-3xl font-bold theme-h1-color">Attendance Kiosk</h1>
            </div>

            <div className="w-full max-w-xl rounded-xl border p-8 flex flex-col items-center gap-6 backdrop-blur-sm" style={cardStyle}>
                {result?.kind === "success" ? (
                    <div className="flex flex-col items-center gap-4 py-4 text-center">
                        {result.status === "checked_in"
                            ? <CheckCircle2 size={64} className="theme-text-contrast" />
                            : <LogOut size={64} className="theme-subtext-color" />}
                        <p className="text-3xl font-bold theme-text">
                            {result.name} checked {result.status === "checked_in" ? "in" : "out"}
                        </p>
                    </div>
                ) : result?.kind === "error" ? (
                    <div className="flex flex-col items-center gap-4 py-4 text-center">
                        <XCircle size={64} className="text-red-500" />
                        <p className="text-2xl font-bold theme-text">{result.message}</p>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-4 py-4 text-center">
                        <ScanLine size={64} className="theme-text-contrast" />
                        <div>
                            <p className="text-xs font-semibold tracking-wider theme-subtext-color">CHECK IN / CHECK OUT</p>
                            <h2 className="text-xl font-bold theme-text">Ready to tap</h2>
                        </div>
                    </div>
                )}

                {/* Invisible capture layer: the RFID reader types into this
                    always-focused input; the trailing Enter submits the form. */}
                <form onSubmit={(e) => void handleSubmit(e)} aria-hidden="true">
                    <input
                        ref={inputRef}
                        value={id}
                        onChange={(e) => setId(e.target.value)}
                        onBlur={() => inputRef.current?.focus()}
                        autoComplete="off"
                        className="absolute h-0 w-0 opacity-0 pointer-events-none"
                    />
                </form>
            </div>

            <button
                onClick={() => void handleDeauthorize()}
                className="text-xs theme-subtext-color hover:opacity-70 transition-opacity underline underline-offset-2"
            >
                Deauthorize this kiosk
            </button>
        </div>
    )
}
