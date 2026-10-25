import { useState } from "react"
import { KeyRound, ShieldCheck } from "lucide-react"
import { verifyCode } from "@/lib/api"
import { useNfcScan } from "@/lib/nfc"
import { CardTitle, CodeField, KioskHeader, PrimaryButton, cardClass, cardStyle } from "@/components/kiosk"

/**
 * First-startup screen: a captain / scouting member enters their offline code
 * once. The backend verifies it and answers with an httponly kiosk_auth
 * cookie, which the browser then sends with every later request.
 */
export default function SetupPage({ onAuthorized }: { onAuthorized: () => void }) {
    const [code, setCode] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Card taps can't be recorded until the kiosk is authorized.
    useNfcScan(null)

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
            <KioskHeader />

            <form onSubmit={(e) => void handleSubmit(e)} className={cardClass} style={cardStyle}>
                <CardTitle icon={ShieldCheck} eyebrow="KIOSK SETUP" title="Authorize this kiosk" />

                <p className="text-sm theme-subtext-color leading-relaxed">
                    Enter your offline code to unlock this device for attendance
                    check-ins. It stays authorized until it's logged out.
                </p>

                <CodeField
                    icon={KeyRound}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Offline code"
                    autoFocus
                />

                <PrimaryButton type="submit" disabled={submitting || !code.trim()}>
                    <ShieldCheck size={16} />
                    {submitting ? "Authorizing…" : "Authorize kiosk"}
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
