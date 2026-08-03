import { useCallback, useState } from "react"
import SetupPage from "@/pages/SetupPage"
import KioskPage from "@/pages/KioskPage"
import ManualCheckinPage from "@/pages/ManualCheckinPage"

// The kiosk_auth cookie is httponly and invisible to JS, so this flag mirrors
// whether setup completed. A stale flag self-heals: the first scan gets a 401
// and drops back to setup.
const AUTH_FLAG = "kiosk_authorized"

type Screen = "setup" | "kiosk" | "manual"

export default function App() {
    const [screen, setScreen] = useState<Screen>(() =>
        localStorage.getItem(AUTH_FLAG) === "1" ? "kiosk" : "setup")

    const handleAuthorized = useCallback(() => {
        localStorage.setItem(AUTH_FLAG, "1")
        setScreen("kiosk")
    }, [])

    const handleDeauthorized = useCallback(() => {
        localStorage.removeItem(AUTH_FLAG)
        setScreen("setup")
    }, [])

    switch (screen) {
        case "kiosk":
            return (
                <KioskPage
                    onDeauthorized={handleDeauthorized}
                    onManualCheckin={() => setScreen("manual")}
                />
            )
        case "manual":
            return (
                <ManualCheckinPage
                    onBack={() => setScreen("kiosk")}
                    onDeauthorized={handleDeauthorized}
                />
            )
        default:
            return <SetupPage onAuthorized={handleAuthorized} />
    }
}
