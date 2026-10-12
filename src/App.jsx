import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home.jsx'
import PartFrame from './pages/PartFrame.jsx'
import { PARTS } from './parts.js'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      {PARTS.map((p) => (
        <Route key={p.path} path={p.path} element={<PartFrame part={p} />} />
      ))}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
