import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/App"
import "./index.css"

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
)

// Prevent right-click context menu
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Prevent keyboard shortcuts like Ctrl+R / F5 refresh, Ctrl+P, etc.
// Compare lowercased keys so Caps Lock or Shift doesn't slip past.
document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (
        key === 'f5' ||
        key === 'f12' ||
        (e.ctrlKey && ['r', 'p', 'w', 'u'].includes(key)) ||
        (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(key)) ||
        (e.altKey && key === 'f4') // Note: OS may catch Alt+F4 before JS
    ) {
        e.preventDefault();
    }
});
