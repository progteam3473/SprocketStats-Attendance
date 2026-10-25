import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { ArrowLeft, KeyRound, Power } from "lucide-react"
import { useNfcScan } from "@/lib/nfc"
import { useIdleTimeout } from "@/lib/useIdleTimeout"
import { CardTitle, CodeField, KioskHeader, LinkButton, PrimaryButton, cardClass, cardStyle } from "@/components/kiosk"

// Don't leave the exit prompt up if someone opens it and walks away.
const IDLE_TIMEOUT_MS = 30000

/**
 * Hidden admin screen (Ctrl+Shift+Q) for quitting the kiosk app. The code is
 * checked on the Rust side, which quits the app itself when it matches.
 */
export default function ExitPage({ onCancel }: { onCancel: () => void }) {
    const [code, setCode] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useIdleTimeout(IDLE_TIMEOUT_MS, onCancel)
    useNfcScan(null)

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        if (!code || submitting) return
        setSubmitting(true)
        setError(null)
        try {
            // Resolves true just before the app quits; false on a wrong code.
            if (!(await invoke<boolean>("exit_app", { code }))) setError("Wrong exit code")
        } catch {
            setError("Couldn't exit the app")
        } finally {
            setCode("")
            setSubmitting(false)
        }
    }

    return (
        <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-8 gap-6">
            <LinkButton onClick={onCancel} className="absolute top-4 left-4">
                <ArrowLeft size={14} />
                Back to kiosk
            </LinkButton>

            <KioskHeader />

            <form onSubmit={(e) => void handleSubmit(e)} className={cardClass} style={cardStyle}>
                <CardTitle icon={Power} eyebrow="ADMIN" title="Exit kiosk app" />

                <CodeField
                    icon={KeyRound}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Exit code"
                    autoFocus
                />

                <PrimaryButton type="submit" disabled={submitting || !code}>
                    <Power size={16} />
                    {submitting ? "Exiting…" : "Exit app"}
                </PrimaryButton>

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
