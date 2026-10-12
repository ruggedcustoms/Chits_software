import { useEffect } from 'react'
import { Link } from 'react-router-dom'

// Shows one part of the software full screen, with a slim bar back to the home page.
export default function PartFrame({ part }) {
  useEffect(() => {
    document.title = part.name + ' · Chit Master Pro'
    return () => {
      document.title = 'Chit Master Pro'
    }
  }, [part])

  return (
    <div className="frame">
      <nav className="frame-bar">
        <Link to="/">← All parts</Link>
        <span>{part.name}</span>
        <a href={part.file} target="_blank" rel="noopener">Open in new tab</a>
      </nav>
      <iframe src={part.file} title={part.name} />
    </div>
  )
}
