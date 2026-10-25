import type { ComponentProps, ReactNode, Ref } from "react"
import { CheckCircle2, LogOut, XCircle, type LucideIcon } from "lucide-react"
import type { VerifyIdResult } from "@/lib/api"

export const cardStyle = { background: "var(--theme-bg)", borderColor: "var(--theme-border)" }
const fieldStyle = { background: "color-mix(in oklch, var(--theme-button-bg) 60%, transparent)", borderColor: "var(--theme-border)" }
const primaryButtonStyle = { background: "var(--theme-text-contrast)", color: "var(--theme-bg)" }

export const cardClass = "w-full max-w-md rounded-xl border p-6 flex flex-col gap-4 backdrop-blur-sm"

export type ScanResult =
    | { kind: "success", name: string, status: VerifyIdResult["status"] }
    | { kind: "error", message: string }

export function KioskHeader() {
    return (
        <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-xs font-semibold tracking-widest theme-subtext-color">SPROCKETSTATS</p>
            <h1 className="text-3xl font-bold theme-h1-color">Attendance Kiosk</h1>
        </div>
    )
}

/** Big icon + message shown after a check-in attempt. */
export function ResultView({ result, size = "lg" }: { result: ScanResult, size?: "md" | "lg" }) {
    const big = size === "lg"
    return (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
            {result.kind === "success" ? (
                <>
                    {result.status === "checked_in"
                        ? <CheckCircle2 size={64} className="theme-text-contrast" />
                        : <LogOut size={64} className="theme-subtext-color" />}
                    <p className={`${big ? "text-3xl" : "text-2xl"} font-bold theme-text`}>
                        {result.name} checked {result.status === "checked_in" ? "in" : "out"}
                    </p>
                </>
            ) : (
                <>
                    <XCircle size={64} className="text-red-500" />
                    <p className={`${big ? "text-2xl" : "text-xl"} font-bold theme-text`}>{result.message}</p>
                </>
            )}
        </div>
    )
}

export function CardTitle({ icon: Icon, eyebrow, title, children }: {
    icon: LucideIcon
    eyebrow?: string
    title: string
    children?: ReactNode
}) {
    return (
        <div className="flex items-center gap-3">
            <Icon size={22} className="theme-text-contrast shrink-0" />
            <div>
                {eyebrow && <p className="text-xs font-semibold tracking-wider theme-subtext-color">{eyebrow}</p>}
                <h2 className="text-lg font-bold theme-text">{title}</h2>
                {children}
            </div>
        </div>
    )
}

/** Password-style input with a leading icon, used for every code entry. */
export function CodeField({ icon: Icon, inputRef, ...props }: Omit<ComponentProps<"input">, "ref"> & {
    icon: LucideIcon
    inputRef?: Ref<HTMLInputElement>
}) {
    return (
        <div className="flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5" style={fieldStyle}>
            <Icon size={16} className="theme-subtext-color shrink-0" />
            <input
                ref={inputRef}
                type="password"
                autoComplete="off"
                className="w-full bg-transparent outline-none text-sm theme-text placeholder:opacity-60"
                {...props}
            />
        </div>
    )
}

export function PrimaryButton({ className = "", ...props }: ComponentProps<"button">) {
    return (
        <button
            className={`flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-semibold text-sm transition-opacity hover:opacity-90 disabled:opacity-60 ${className}`}
            style={primaryButtonStyle}
            {...props}
        />
    )
}

export function LinkButton({ className = "", ...props }: ComponentProps<"button">) {
    return (
        <button
            className={`flex items-center justify-center gap-1.5 text-xs theme-subtext-color hover:opacity-70 transition-opacity underline underline-offset-2 ${className}`}
            {...props}
        />
    )
}
