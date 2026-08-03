import { useState } from "react"
import { KeyRound, ShieldCheck } from "lucide-react"
import { verifyCode } from "@/lib/api"

const cardStyle = { background: "var(--theme-bg)", borderColor: "var(--theme-border)" }
const fieldStyle = { background: "color-mix(in oklch, var(--theme-button-bg) 60%, transparent)", borderColor: "var(--theme-border)" }

/**
 * First-startup screen: a captain / scouting member enters their offline code
 * once. The backend verifies it and answers with an httponly kiosk_auth
 * cookie, which the browser then sends with every later request.
 */
export default function SetupPage({ onAuthorized }: { onAuthorized: () => void }) {
    const [code, setCode] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        const trimmed = code.trim()
        if (!trimmed || submitting) return
        setSubmitting(true)
        setError(null)
        try {
            await verifyCode(trimmed)
            onAuthorized()
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to authorize kiosk")
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8 gap-6">
            <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-xs font-semibold tracking-widest theme-subtext-color">SPROCKETSTATS</p>
                <h1 className="text-3xl font-bold theme-h1-color">Attendance Kiosk</h1>
            </div>

            <form
                onSubmit={(e) => void handleSubmit(e)}
                className="w-full max-w-md rounded-xl border p-6 flex flex-col gap-4 backdrop-blur-sm"
                style={cardStyle}
            >
                <div className="flex items-center gap-3">
                    <ShieldCheck size={22} className="theme-text-contrast shrink-0" />
                    <div>
                        <p className="text-xs font-semibold tracking-wider theme-subtext-color">KIOSK SETUP</p>
                        <h2 className="text-lg font-bold theme-text">Authorize this kiosk</h2>
                    </div>
                </div>

                <p className="text-sm theme-subtext-color leading-relaxed">
                    Enter your offline code to unlock this device for attendance
                    check-ins. It stays authorized until it's logged out.
                </p>

                <div className="flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5" style={fieldStyle}>
                    <KeyRound size={16} className="theme-subtext-color shrink-0" />
                    <input
                        type="password"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="Offline code"
                        autoFocus
                        autoComplete="off"
                        className="w-full bg-transparent outline-none text-sm theme-text placeholder:opacity-60"
                    />
                </div>

                <button
                    type="submit"
                    disabled={submitting || !code.trim()}
                    className="flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-semibold text-sm transition-opacity hover:opacity-90 disabled:opacity-60"
                    style={{ background: "var(--theme-text-contrast)", color: "var(--theme-bg)" }}
                >
                    <ShieldCheck size={16} />
                    {submitting ? "Authorizing…" : "Authorize kiosk"}
                </button>

                {error && (
                    <p className="text-sm px-3 py-2 rounded-lg border theme-subtext-color theme-border"
                       style={{ background: "color-mix(in oklch, var(--theme-border) 40%, transparent)" }}>
                        {error}
                    </p>
                )}
            </form>
        </div>
    )
}
