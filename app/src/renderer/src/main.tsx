import './styles/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startErrorReporting } from './errorReporting'
import { startTheme } from './theme'

// Before the first render, so the app never paints in the wrong theme.
startTheme()
startErrorReporting()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
