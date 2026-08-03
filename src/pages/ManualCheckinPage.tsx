import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, CheckCircle2, KeyRound, LogOut, ShieldCheck, UserRound, XCircle } from "lucide-react"
import { ApiError, lookupMember, verifyCheckinCode, type VerifyIdResult } from "@/lib/api"

const RESULT_DISMISS_MS = 3500
const LOOKUP_DEBOUNCE_MS = 500

const cardStyle = { background: "var(--theme-bg)", borderColor: "var(--theme-border)" }
const fieldStyle = { background: "color-mix(in oklch, var(--theme-button-bg) 60%, transparent)", borderColor: "var(--theme-border)" }

type Result =
    | { kind: "success", name: string, status: VerifyIdResult["status"] }
    | { kind: "error", message: string }

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
    const [result, setResult] = useState<Result | null>(null)
    const [lookup, setLookup] = useState<Lookup | null>(null)
    // Guards against a slow lookup response landing after a newer one.
    const lookupSeq = useRef(0)
    const adminInputRef = useRef<HTMLInputElement>(null)

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

    // Admin RFID readers act as keyboards, so on the confirm step the admin
    // field must always own focus for a card tap to land in it.
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

    async function handleConfirm(e: React.FormEvent) {
        e.preventDefault()
        const member = memberCode.trim()
        const admin = adminCode.trim()
        if (!member || !admin || submitting) return
        setSubmitting(true)
        try {
            const { name, status } = await verifyCheckinCode(member, admin)
            setResult({ kind: "success", name, status })
            setMemberCode("")
            setMemberName("")
            setAdminCode("")
            setStep("member")
        } catch (err) {
            // A 401 usually means the kiosk cookie is gone — send it back through
            // setup. But verify_checkin_code also answers 401 for a bad admin
            // code, which should stay an inline error on this page.
            if (err instanceof ApiError && err.status === 401 && err.message !== "Invalid admin code") {
                onDeauthorized()
                return
            }
            setResult({ kind: "error", message: err instanceof Error ? err.message : "Check-in failed" })
            // Stay on the admin step so the admin can retry with the member kept.
            setAdminCode("")
        } finally {
            setSubmitting(false)
        }
    }

    function handleBackToMember() {
        setAdminCode("")
        setStep("member")
    }

    return (
        <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-8 gap-6">
            <button
                onClick={onBack}
                className="absolute top-4 left-4 flex items-center gap-1.5 text-xs theme-subtext-color hover:opacity-70 transition-opacity underline underline-offset-2"
            >
                <ArrowLeft size={14} />
                Back to kiosk
            </button>

            <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-xs font-semibold tracking-widest theme-subtext-color">SPROCKETSTATS</p>
                <h1 className="text-3xl font-bold theme-h1-color">Attendance Kiosk</h1>
            </div>

            {result ? (
                <div className="w-full max-w-md rounded-xl border p-8 flex flex-col items-center gap-4 backdrop-blur-sm text-center" style={cardStyle}>
                    {result.kind === "success" ? (
                        <>
                            {result.status === "checked_in"
                                ? <CheckCircle2 size={64} className="theme-text-contrast" />
                                : <LogOut size={64} className="theme-subtext-color" />}
                            <p className="text-2xl font-bold theme-text">
                                {result.name} checked {result.status === "checked_in" ? "in" : "out"}
                            </p>
                        </>
                    ) : (
                        <>
                            <XCircle size={64} className="text-red-500" />
                            <p className="text-xl font-bold theme-text">{result.message}</p>
                        </>
                    )}
                </div>
            ) : step === "member" ? (
                <form
                    onSubmit={handleNext}
                    className="w-full max-w-md rounded-xl border p-6 flex flex-col gap-4 backdrop-blur-sm"
                    style={cardStyle}
                >
                    <div className="flex items-center gap-3">
                        <UserRound size={22} className="theme-text-contrast shrink-0" />
                        <div>
                            <h2 className="text-lg font-bold theme-text">Manual check-in/out</h2>
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
                        </div>
                    </div>

                    <p className="text-sm theme-subtext-color leading-relaxed">
                        Enter your offline code, then continue to have an admin
                        confirm the check-in.
                    </p>

                    <div className="flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5" style={fieldStyle}>
                        <UserRound size={16} className="theme-subtext-color shrink-0" />
                        <input
                            type="password"
                            value={memberCode}
                            onChange={(e) => setMemberCode(e.target.value)}
                            placeholder="Your code"
                            autoFocus
                            autoComplete="off"
                            className="w-full bg-transparent outline-none text-sm theme-text placeholder:opacity-60"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={lookup?.kind !== "found"}
                        className="flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-semibold text-sm transition-opacity hover:opacity-90 disabled:opacity-60"
                        style={{ background: "var(--theme-text-contrast)", color: "var(--theme-bg)" }}
                    >
                        Next
                        <ArrowRight size={16} />
                    </button>
                </form>
            ) : (
                <form
                    onSubmit={(e) => void handleConfirm(e)}
                    className="w-full max-w-md rounded-xl border p-6 flex flex-col gap-4 backdrop-blur-sm"
                    style={cardStyle}
                >
                    <div className="flex items-center gap-3">
                        <ShieldCheck size={22} className="theme-text-contrast shrink-0" />
                        <div>
                            <h2 className="text-lg font-bold theme-text">Admin confirmation</h2>
                            <p className="text-lg px-1">
                                <span className="theme-text-contrast font-semibold">{memberName}</span>
                            </p>
                        </div>
                    </div>

                    <p className="text-sm theme-subtext-color leading-relaxed">
                        Have an admin tap their RFID card or enter their code to
                        confirm the check-in.
                    </p>

                    <div className="flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5" style={fieldStyle}>
                        <KeyRound size={16} className="theme-subtext-color shrink-0" />
                        <input
                            ref={adminInputRef}
                            type="password"
                            value={adminCode}
                            onChange={(e) => setAdminCode(e.target.value)}
                            onBlur={() => adminInputRef.current?.focus()}
                            placeholder="Admin code"
                            autoFocus
                            autoComplete="off"
                            className="w-full bg-transparent outline-none text-sm theme-text placeholder:opacity-60"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={submitting || !adminCode.trim()}
                        className="flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-semibold text-sm transition-opacity hover:opacity-90 disabled:opacity-60"
                        style={{ background: "var(--theme-text-contrast)", color: "var(--theme-bg)" }}
                    >
                        <ShieldCheck size={16} />
                        {submitting ? "Checking in…" : "Check in / out"}
                    </button>

                    <button
                        type="button"
                        onClick={handleBackToMember}
                        className="flex items-center justify-center gap-1.5 text-xs theme-subtext-color hover:opacity-70 transition-opacity underline underline-offset-2"
                    >
                        <ArrowLeft size={14} />
                        Not you? Go back
                    </button>
                </form>
            )}
        </div>
    )
}
