import { Link } from 'react-router-dom'
import { PARTS } from '../parts.js'

export default function Home() {
  return (
    <div className="home">
      <header className="home-head">
        <div className="logo">C</div>
        <div>
          <h1>Chit Master Pro</h1>
          <p>Chit fund management software</p>
        </div>
      </header>
      <main className="cards">
        {PARTS.map((p) => (
          <Link key={p.path} to={p.path} className="card">
            <span className="who">{p.who}</span>
            <h2>{p.name}</h2>
            <p>{p.about}</p>
            <span className="open">Open</span>
          </Link>
        ))}
      </main>
    </div>
  )
}
