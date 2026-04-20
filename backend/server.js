const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json());

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  database: 'postgres',
});

// ── DB Init ──────────────────────────────────────────────────────────────────

async function initDB() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS tournament`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament.tournaments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament.participants (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER REFERENCES tournament.tournaments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      seed INTEGER NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament.matches (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER REFERENCES tournament.tournaments(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      position INTEGER NOT NULL,
      participant1_id INTEGER REFERENCES tournament.participants(id),
      participant2_id INTEGER REFERENCES tournament.participants(id),
      p1_bye BOOLEAN DEFAULT FALSE,
      p2_bye BOOLEAN DEFAULT FALSE,
      score1 INTEGER,
      score2 INTEGER,
      winner_id INTEGER REFERENCES tournament.participants(id),
      next_match_id INTEGER,
      next_match_slot INTEGER
    )
  `);
}

// ── Bracket Generation ───────────────────────────────────────────────────────

function nextPowerOf2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function generateSeeds(size) {
  if (size === 1) return [1];
  if (size === 2) return [1, 2];
  const half = generateSeeds(size / 2);
  const result = [];
  for (const seed of half) {
    result.push(seed);
    result.push(size + 1 - seed);
  }
  return result;
}

async function createBracket(client, tournamentId, participants) {
  const n = participants.length;
  const bracketSize = nextPowerOf2(n);
  const numRounds = Math.log2(bracketSize);

  // Insert participants with seeds
  const participantRows = [];
  for (let i = 0; i < participants.length; i++) {
    const res = await client.query(
      `INSERT INTO tournament.participants (tournament_id, name, seed) VALUES ($1, $2, $3) RETURNING id`,
      [tournamentId, participants[i], i + 1]
    );
    participantRows.push({ id: res.rows[0].id, name: participants[i], seed: i + 1 });
  }

  // Build seed → participant map
  const seedToParticipant = {};
  for (const p of participantRows) {
    seedToParticipant[p.seed] = p;
  }

  // Create all matches for all rounds
  // We'll store them and link them after
  const matchIds = {}; // key: `${round}-${position}` → id

  for (let r = 1; r <= numRounds; r++) {
    const matchCount = bracketSize / Math.pow(2, r);
    for (let pos = 1; pos <= matchCount; pos++) {
      const res = await client.query(
        `INSERT INTO tournament.matches (tournament_id, round, position) VALUES ($1, $2, $3) RETURNING id`,
        [tournamentId, r, pos]
      );
      matchIds[`${r}-${pos}`] = res.rows[0].id;
    }
  }

  // Set next_match_id for each match (except the final)
  for (let r = 1; r < numRounds; r++) {
    const matchCount = bracketSize / Math.pow(2, r);
    for (let pos = 1; pos <= matchCount; pos++) {
      const nextPos = Math.ceil(pos / 2);
      const nextSlot = pos % 2 === 1 ? 1 : 2;
      const currentId = matchIds[`${r}-${pos}`];
      const nextId = matchIds[`${r + 1}-${nextPos}`];
      await client.query(
        `UPDATE tournament.matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3`,
        [nextId, nextSlot, currentId]
      );
    }
  }

  // Fill round 1 participants from seed array
  const seeds = generateSeeds(bracketSize);
  const round1Count = bracketSize / 2;

  for (let pos = 1; pos <= round1Count; pos++) {
    const seed1 = seeds[(pos - 1) * 2];
    const seed2 = seeds[(pos - 1) * 2 + 1];
    const p1 = seed1 <= n ? seedToParticipant[seed1] : null;
    const p2 = seed2 <= n ? seedToParticipant[seed2] : null;
    const p1_bye = seed1 > n;
    const p2_bye = seed2 > n;
    const matchId = matchIds[`1-${pos}`];

    await client.query(
      `UPDATE tournament.matches
       SET participant1_id = $1, participant2_id = $2, p1_bye = $3, p2_bye = $4
       WHERE id = $5`,
      [p1 ? p1.id : null, p2 ? p2.id : null, p1_bye, p2_bye, matchId]
    );

    // Auto-resolve bye matches
    if (p1_bye || p2_bye) {
      const winner = p1_bye ? p2 : p1;
      if (winner) {
        await client.query(
          `UPDATE tournament.matches SET winner_id = $1 WHERE id = $2`,
          [winner.id, matchId]
        );
        // Advance winner to next match
        const nextMatchId = matchIds[`2-${Math.ceil(pos / 2)}`];
        if (nextMatchId) {
          const slot = pos % 2 === 1 ? 1 : 2;
          if (slot === 1) {
            await client.query(
              `UPDATE tournament.matches SET participant1_id = $1 WHERE id = $2`,
              [winner.id, nextMatchId]
            );
          } else {
            await client.query(
              `UPDATE tournament.matches SET participant2_id = $1 WHERE id = $2`,
              [winner.id, nextMatchId]
            );
          }
        }
      }
    }
  }
}

// ── Fetch bracket for a tournament ───────────────────────────────────────────

async function fetchBracket(tournamentId) {
  const tRes = await pool.query(
    `SELECT id, name FROM tournament.tournaments WHERE id = $1`,
    [tournamentId]
  );
  if (tRes.rows.length === 0) return null;

  const mRes = await pool.query(
    `SELECT
       m.id, m.round, m.position,
       m.p1_bye, m.p2_bye,
       m.score1, m.score2,
       m.winner_id, m.next_match_id, m.next_match_slot,
       p1.id as p1_id, p1.name as p1_name,
       p2.id as p2_id, p2.name as p2_name
     FROM tournament.matches m
     LEFT JOIN tournament.participants p1 ON m.participant1_id = p1.id
     LEFT JOIN tournament.participants p2 ON m.participant2_id = p2.id
     WHERE m.tournament_id = $1
     ORDER BY m.round, m.position`,
    [tournamentId]
  );

  const matches = mRes.rows.map(r => ({
    id: r.id,
    round: r.round,
    position: r.position,
    p1: r.p1_id ? { id: r.p1_id, name: r.p1_name } : null,
    p2: r.p2_id ? { id: r.p2_id, name: r.p2_name } : null,
    p1_bye: r.p1_bye,
    p2_bye: r.p2_bye,
    score1: r.score1,
    score2: r.score2,
    winner_id: r.winner_id,
    next_match_id: r.next_match_id,
    next_match_slot: r.next_match_slot,
  }));

  // Find champion: winner of the final (last round, position 1)
  const maxRound = Math.max(...matches.map(m => m.round));
  const finalMatch = matches.find(m => m.round === maxRound && m.position === 1);
  let champion = null;
  if (finalMatch && finalMatch.winner_id) {
    const wRes = await pool.query(
      `SELECT name FROM tournament.participants WHERE id = $1`,
      [finalMatch.winner_id]
    );
    if (wRes.rows.length > 0) champion = wRes.rows[0].name;
  }

  return {
    tournament: tRes.rows[0],
    matches,
    champion,
  };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Map: tournamentId → Set of WebSocket clients
const rooms = new Map();

function joinRoom(ws, tournamentId) {
  if (!rooms.has(tournamentId)) rooms.set(tournamentId, new Set());
  rooms.get(tournamentId).add(ws);
  broadcastUserCount(tournamentId);
}

function leaveRoom(ws) {
  for (const [tid, clients] of rooms.entries()) {
    if (clients.has(ws)) {
      clients.delete(ws);
      broadcastUserCount(tid);
    }
  }
}

function broadcastUserCount(tournamentId) {
  const clients = rooms.get(tournamentId);
  const count = clients ? clients.size : 0;
  broadcast(tournamentId, { type: 'user_count', count });
}

function broadcast(tournamentId, data) {
  const clients = rooms.get(tournamentId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  }
}

wss.on('connection', ws => {
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && msg.tournamentId) {
        joinRoom(ws, String(msg.tournamentId));
      }
    } catch {}
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/tournaments
app.get('/api/tournaments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, created_at FROM tournament.tournaments ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tournaments
app.post('/api/tournaments', async (req, res) => {
  const { name, participants } = req.body;
  if (!name || !participants || !Array.isArray(participants)) {
    return res.status(400).json({ error: 'name and participants required' });
  }
  const filtered = participants.map(p => p.trim()).filter(p => p.length > 0);
  if (filtered.length < 3 || filtered.length > 16) {
    return res.status(400).json({ error: 'Need 3–16 participants' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query(
      `INSERT INTO tournament.tournaments (name) VALUES ($1) RETURNING id, name`,
      [name]
    );
    const tournament = tRes.rows[0];
    await createBracket(client, tournament.id, filtered);
    await client.query('COMMIT');
    res.json(tournament);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/tournaments
app.delete('/api/tournaments', async (req, res) => {
  try {
    await pool.query(`DELETE FROM tournament.tournaments`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tournaments/:id
app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const bracket = await fetchBracket(req.params.id);
    if (!bracket) return res.status(404).json({ error: 'Not found' });
    res.json(bracket);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tournaments/:id/matches/:matchId/score
app.post('/api/tournaments/:id/matches/:matchId/score', async (req, res) => {
  const { score1, score2 } = req.body;
  const matchId = parseInt(req.params.matchId);
  const tournamentId = req.params.id;

  if (score1 === score2) {
    return res.status(400).json({ error: 'Tied scores are not allowed' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch match
    const mRes = await client.query(
      `SELECT m.*, p1.id as p1_id, p2.id as p2_id
       FROM tournament.matches m
       LEFT JOIN tournament.participants p1 ON m.participant1_id = p1.id
       LEFT JOIN tournament.participants p2 ON m.participant2_id = p2.id
       WHERE m.id = $1`,
      [matchId]
    );
    if (mRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found' });
    }

    const match = mRes.rows[0];
    if (match.winner_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Match already completed' });
    }
    if (!match.participant1_id || !match.participant2_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Match participants not yet determined' });
    }

    const winnerId = score1 > score2 ? match.participant1_id : match.participant2_id;

    await client.query(
      `UPDATE tournament.matches SET score1 = $1, score2 = $2, winner_id = $3 WHERE id = $4`,
      [score1, score2, winnerId, matchId]
    );

    // Advance winner to next match
    if (match.next_match_id) {
      if (match.next_match_slot === 1) {
        await client.query(
          `UPDATE tournament.matches SET participant1_id = $1 WHERE id = $2`,
          [winnerId, match.next_match_id]
        );
      } else {
        await client.query(
          `UPDATE tournament.matches SET participant2_id = $1 WHERE id = $2`,
          [winnerId, match.next_match_id]
        );
      }
    }

    await client.query('COMMIT');

    // Broadcast updated bracket to all subscribers
    const bracket = await fetchBracket(tournamentId);
    broadcast(String(tournamentId), { type: 'bracket_update', bracket });

    res.json({ ok: true, bracket });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDB().then(() => {
  server.listen(3001, '0.0.0.0', () => {
    console.log('Backend listening on port 3001');
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
