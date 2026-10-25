import { useEffect, useRef, useState } from "react"
import { KeyRound, Nfc } from "lucide-react"
import { ApiError, kioskLogout, verifyId } from "@/lib/api"
import { useNfcScan } from "@/lib/nfc"
import { KioskHeader, LinkButton, ResultView, cardStyle, type ScanResult } from "@/components/kiosk"

const RESULT_DISMISS_MS = 3500
const CONFIRM_LOGOUT_MS = 10000

export default function KioskPage({ onDeauthorized, onManualCheckin }: {
    onDeauthorized: () => void
    onManualCheckin: () => void
}) {
    const [id, setId] = useState("")
    const [result, setResult] = useState<ScanResult | null>(null)
    const [confirmingLogout, setConfirmingLogout] = useState(false)
    // A ref, not state: two scans can land before a re-render.
    const inFlight = useRef(false)
    const inputRef = useRef<HTMLInputElement>(null)

    // Keyboard-wedge readers (and the web build) type into the hidden input,
    // so it must always own focus. The built-in reader goes through useNfcScan.
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

    useEffect(() => {
        if (!confirmingLogout) return
        const t = window.setTimeout(() => setConfirmingLogout(false), CONFIRM_LOGOUT_MS)
        return () => window.clearTimeout(t)
    }, [confirmingLogout])

    async function submitScan(scanned: string): Promise<boolean> {
        if (!scanned || inFlight.current) return false
        inFlight.current = true
        try {
            const { name, status } = await verifyId(scanned)
            setResult({ kind: "success", name, status })
            return true
        } catch (err) {
            // The kiosk cookie is gone or expired — send it back through setup.
            if (err instanceof ApiError && err.status === 401) {
                onDeauthorized()
                return false
            }
            setResult({ kind: "error", message: err instanceof Error ? err.message : "Scan failed" })
            return false
        } finally {
            inFlight.current = false
            inputRef.current?.focus()
        }
    }

    useNfcScan(submitScan)

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        const scanned = id.trim()
        setId("")
        void submitScan(scanned)
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
            <LinkButton onClick={onManualCheckin} className="absolute top-4 right-4">
                <KeyRound size={14} />
                Manual check-in
            </LinkButton>

            <KioskHeader />

            <div className="w-full max-w-xl rounded-xl border p-8 flex flex-col items-center gap-6 backdrop-blur-sm" style={cardStyle}>
                {result ? <ResultView result={result} /> : (
                    <div className="flex flex-col items-center gap-4 py-4 text-center">
                        <Nfc size={64} className="theme-h1-color" />
                        <div>
                            <p className="text-xs font-semibold tracking-wider theme-subtext-color">CHECK IN / CHECK OUT</p>
                            <h2 className="text-xl font-bold theme-text">Ready to tap</h2>
                        </div>
                    </div>
                )}

                {/* Invisible capture layer: a keyboard-wedge reader types into
                    this always-focused input; the trailing Enter submits it. */}
                <form onSubmit={handleSubmit} aria-hidden="true">
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

            {/* One stray tap shouldn't knock the kiosk offline until a captain
                comes by, so deauthorizing takes a deliberate second step. */}
            {confirmingLogout ? (
                <div className="flex flex-col items-center gap-2 text-center">
                    <p className="text-sm theme-subtext-color">
                        Deauthorize? A captain's code is needed to set it up again.
                    </p>
                    <div className="flex gap-4">
                        <LinkButton onClick={() => setConfirmingLogout(false)}>Cancel</LinkButton>
                        <LinkButton onClick={() => void handleDeauthorize()} className="text-red-400!">
                            Yes, deauthorize
                        </LinkButton>
                    </div>
                </div>
            ) : (
                <LinkButton onClick={() => setConfirmingLogout(true)}>
                    Deauthorize this kiosk
                </LinkButton>
            )}
        </div>
    )
}
