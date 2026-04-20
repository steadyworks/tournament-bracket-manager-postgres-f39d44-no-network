import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import TournamentList from './pages/TournamentList'
import BracketView from './pages/BracketView'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TournamentList />} />
        <Route path="/tournament/:id" element={<BracketView />} />
      </Routes>
    </BrowserRouter>
  )
}
