import { useRef, useState } from "react"
import { Loader2, ShieldCheck, XCircle } from "lucide-react"
import { authorizeKiosk } from "@/lib/api"
import { useServerClock } from "@/lib/clock"
import { useNfcScan } from "@/lib/nfc"
import { useCodeScanner } from "@/lib/useCodeScanner"
import { CameraPreview } from "@/components/CameraPreview"
import { CloseAppButton, KioskTitle, cardStyle } from "@/components/kiosk"

type SetupState =
    | { kind: "waiting" }
    | { kind: "checking" }
    | { kind: "error", message: string }

/**
 * First-startup screen: a member allowed to authorize kiosks (captains and
 * scouting leads/members) shows their code from the app to the camera. The
 * backend checks it and answers with an httponly kiosk_auth cookie naming this
 * kiosk, which the browser then sends with every later request.
 */
export default function SetupPage({ onAuthorized }: { onAuthorized: () => void }) {
    const [state, setState] = useState<SetupState>({ kind: "waiting" })
    const busy = useRef(false)

    // Card taps can't be recorded until the kiosk is authorized.
    useNfcScan(null)
    useServerClock()

    const scanner = useCodeScanner(async (code, scannedAt) => {
        if (busy.current) return { ok: false, label: "One at a time" }
        busy.current = true
        setState({ kind: "checking" })
        try {
            await authorizeKiosk(code, scannedAt, crypto.randomUUID())
            onAuthorized()
            return { ok: true, label: "Authorized" }
        } catch (err) {
            setState({ kind: "error", message: err instanceof Error ? err.message : "Couldn't authorize this kiosk" })
            return { ok: false, label: "Not allowed" }
        } finally {
            busy.current = false
        }
    })

    return (
        <div className="relative h-screen flex flex-col items-center gap-4 pt-6 overflow-hidden">
            <KioskTitle />
            <CloseAppButton />

            <div className="h-[204px] shrink-0 flex items-center justify-center">
                <div
                    className="w-[448px] max-w-[92vw] rounded-xl border p-6 flex flex-col items-center gap-3 text-center backdrop-blur-sm"
                    style={cardStyle}
                >
                    <div className="flex items-center gap-2.5">
                        <ShieldCheck size={26} className="theme-text-contrast" />
                        <h2 className="text-2xl font-bold theme-text">Authorize this kiosk</h2>
                    </div>
                    {state.kind === "error" && (
                        <div
                            className="w-full flex items-center justify-center gap-2.5 rounded-lg border px-3 py-2.5"
                            style={{ borderColor: "var(--theme-border)", background: "color-mix(in oklch, var(--theme-border) 40%, transparent)" }}
                        >
                            <XCircle size={20} className="text-red-400 shrink-0" />
                            <p className="text-[15px] theme-text">{state.message}</p>
                        </div>
                    )}
                    {state.kind === "checking" ? (
                        <div role="status" className="flex items-center gap-2.5">
                            <Loader2 size={22} className="theme-h1-color animate-spin" />
                            <p className="text-lg font-semibold theme-text">Checking…</p>
                        </div>
                    ) : (
                        <p className="text-lg font-semibold theme-text">Scan a captain's code</p>
                    )}
                </div>
            </div>

            <CameraPreview {...scanner} />
        </div>
    )
}
