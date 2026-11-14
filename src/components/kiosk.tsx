import type { ComponentProps } from "react"
import { X } from "lucide-react"
import { invoke, isTauri } from "@tauri-apps/api/core"

export const cardStyle = { background: "var(--theme-bg)", borderColor: "var(--theme-border)" }

/** Gear logo and name, top-left on every kiosk screen. */
export function KioskTitle() {
    return (
        <div className="absolute top-5 left-7 flex items-center gap-2.5">
            <div
                aria-hidden="true"
                className="size-9"
                style={{
                    backgroundColor: "var(--theme-h1-color)",
                    mask: "url(/sprocket_logo_gear.svg) center/contain no-repeat",
                    WebkitMask: "url(/sprocket_logo_gear.svg) center/contain no-repeat",
                }}
            />
            <h1 className="text-xl font-bold theme-h1-color">Attendance Kiosk</h1>
        </div>
    )
}

/**
 * Faint close button, top-right. The window is fullscreen and refuses normal
 * close events, so this calls the app's exit command. Hidden in the web build.
 */
export function CloseAppButton() {
    if (!isTauri()) return null
    return (
        <button
            type="button"
            aria-label="Close app"
            onClick={() => void invoke("exit_app")}
            className="absolute top-5 right-6 size-11 flex items-center justify-center theme-text opacity-20 hover:opacity-60 transition-opacity"
        >
            <X size={22} />
        </button>
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
