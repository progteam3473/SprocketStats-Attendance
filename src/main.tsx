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
document.addEventListener('keydown', (e) => {
    if (
        e.key === 'F5' ||
        (e.ctrlKey && e.key === 'r') ||
        (e.ctrlKey && e.key === 'p') ||
        (e.altKey && e.key === 'F4') // Note: OS may catch Alt+F4 before JS
    ) {
        e.preventDefault();
    }
});
