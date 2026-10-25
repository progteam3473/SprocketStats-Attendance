import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, KeyRound, ShieldCheck, UserRound } from "lucide-react"
import { ApiError, lookupMember, verifyCheckinCode } from "@/lib/api"
import { useNfcScan } from "@/lib/nfc"
import { useIdleTimeout } from "@/lib/useIdleTimeout"
import {
    CardTitle, CodeField, KioskHeader, LinkButton, PrimaryButton, ResultView, cardClass, cardStyle,
    type ScanResult,
} from "@/components/kiosk"

const RESULT_DISMISS_MS = 3500
const LOOKUP_DEBOUNCE_MS = 500
// Walk-aways shouldn't strand the kiosk here (taps aren't recorded on this
// screen) or leave a member's name up on the confirm step.
const IDLE_TIMEOUT_MS = 30000

type Lookup =
    | { kind: "loading" }
    | { kind: "found", name: string }
    | { kind: "not_found" }

type Step = "member" | "admin"

/**
 * Fallback for members without their ID card: they type their offline code,
 * an admin countersigns with theirs, and the pair is verified server-side.
 * Two steps: the member identifies themselves first, then an admin confirms
 * by typing their code or tapping their RFID card.
 */
export default function ManualCheckinPage({ onBack, onDeauthorized }: {
    onBack: () => void
    onDeauthorized: () => void
}) {
    const [step, setStep] = useState<Step>("member")
    const [memberCode, setMemberCode] = useState("")
    const [memberName, setMemberName] = useState("")
    const [adminCode, setAdminCode] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [result, setResult] = useState<ScanResult | null>(null)
    const [lookup, setLookup] = useState<Lookup | null>(null)
    // Guards against a slow lookup response landing after a newer one.
    const lookupSeq = useRef(0)
    const inFlight = useRef(false)
    const adminInputRef = useRef<HTMLInputElement>(null)

    useIdleTimeout(IDLE_TIMEOUT_MS, onBack)

    useEffect(() => {
        const code = memberCode.trim()
        const seq = ++lookupSeq.current
        if (!code) {
            setLookup(null)
            return
        }
        setLookup({ kind: "loading" })
        const t = window.setTimeout(async () => {
            try {
                const { name } = await lookupMember(code)
                if (lookupSeq.current === seq) setLookup({ kind: "found", name })
            } catch (err) {
                if (err instanceof ApiError && err.status === 401) {
                    onDeauthorized()
                    return
                }
                if (lookupSeq.current === seq) setLookup({ kind: "not_found" })
            }
        }, LOOKUP_DEBOUNCE_MS)
        return () => window.clearTimeout(t)
    }, [memberCode, onDeauthorized])

    useEffect(() => {
        if (!result) return
        const t = window.setTimeout(() => setResult(null), RESULT_DISMISS_MS)
        return () => window.clearTimeout(t)
    }, [result])

    // Keyboard-wedge readers type into the focused field, so on the confirm
    // step the admin field must always own focus for a card tap to land in it.
    useEffect(() => {
        if (step !== "admin") return
        const refocus = () => adminInputRef.current?.focus()
        refocus()
        window.addEventListener("click", refocus)
        return () => window.removeEventListener("click", refocus)
    }, [step])

    function handleNext(e: React.FormEvent) {
        e.preventDefault()
        if (lookup?.kind !== "found") return
        setMemberName(lookup.name)
        setStep("admin")
    }

    async function confirm(admin: string): Promise<boolean> {
        const member = memberCode.trim()
        if (!member || !admin || inFlight.current) return false
        inFlight.current = true
        setSubmitting(true)
        try {
            const { name, status } = await verifyCheckinCode(member, admin)
            setResult({ kind: "success", name, status })
            setMemberCode("")
            setMemberName("")
            setAdminCode("")
            setStep("member")
            return true
        } catch (err) {
            // A 401 usually means the kiosk cookie is gone — send it back through
            // setup. But verify_checkin_code also answers 401 for a bad admin
            // code, which should stay an inline error on this page.
            if (err instanceof ApiError && err.status === 401 && err.message !== "Invalid admin code") {
                onDeauthorized()
                return false
            }
            setResult({ kind: "error", message: err instanceof Error ? err.message : "Check-in failed" })
            // Stay on the admin step so the admin can retry with the member kept.
            setAdminCode("")
            return false
        } finally {
            inFlight.current = false
            setSubmitting(false)
        }
    }

    // On the confirm step a tap on the built-in reader is the admin's card.
    useNfcScan(step === "admin" && !result ? confirm : null)

    function handleConfirm(e: React.FormEvent) {
        e.preventDefault()
        void confirm(adminCode.trim())
    }

    function handleBackToMember() {
        setAdminCode("")
        setStep("member")
    }

    return (
        <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-8 gap-6">
            <LinkButton onClick={onBack} className="absolute top-4 left-4">
                <ArrowLeft size={14} />
                Back to kiosk
            </LinkButton>

            <KioskHeader />

            {result ? (
                <div className="w-full max-w-md rounded-xl border p-8 flex flex-col items-center backdrop-blur-sm" style={cardStyle}>
                    <ResultView result={result} size="md" />
                </div>
            ) : step === "member" ? (
                <form onSubmit={handleNext} className={cardClass} style={cardStyle}>
                    <CardTitle icon={UserRound} title="Manual check-in/out">
                        {lookup && (
                            <p className="text-lg px-1">
                                {lookup.kind === "loading" ? (
                                    <span className="theme-subtext-color opacity-80">Looking up…</span>
                                ) : lookup.kind === "found" ? (
                                    <span className="theme-text-contrast font-semibold">{lookup.name}</span>
                                ) : (
                                    <span className="theme-subtext-color opacity-80">No member found</span>
                                )}
                            </p>
                        )}
                    </CardTitle>

                    <p className="text-sm theme-subtext-color leading-relaxed">
                        Enter your offline code, then continue to have an admin
                        confirm the check-in.
                    </p>

                    <CodeField
                        icon={UserRound}
                        value={memberCode}
                        onChange={(e) => setMemberCode(e.target.value)}
                        placeholder="Your code"
                        autoFocus
                    />

                    <PrimaryButton type="submit" disabled={lookup?.kind !== "found"}>
                        Next
                        <ArrowRight size={16} />
                    </PrimaryButton>
                </form>
            ) : (
                <form onSubmit={handleConfirm} className={cardClass} style={cardStyle}>
                    <CardTitle icon={ShieldCheck} title="Admin confirmation">
                        <p className="text-lg px-1">
                            <span className="theme-text-contrast font-semibold">{memberName}</span>
                        </p>
                    </CardTitle>

                    <p className="text-sm theme-subtext-color leading-relaxed">
                        Have an admin tap their RFID card or enter their code to
                        confirm the check-in.
                    </p>

                    <CodeField
                        icon={KeyRound}
                        inputRef={adminInputRef}
                        value={adminCode}
                        onChange={(e) => setAdminCode(e.target.value)}
                        onBlur={() => adminInputRef.current?.focus()}
                        placeholder="Admin code"
                        autoFocus
                    />

                    <PrimaryButton type="submit" disabled={submitting || !adminCode.trim()}>
                        <ShieldCheck size={16} />
                        {submitting ? "Checking in…" : "Check in / out"}
                    </PrimaryButton>

                    <LinkButton type="button" onClick={handleBackToMember}>
                        <ArrowLeft size={14} />
                        Not you? Go back
                    </LinkButton>
                </form>
            )}
        </div>
    )
}
