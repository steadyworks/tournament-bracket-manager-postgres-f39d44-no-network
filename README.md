# Tournament Bracket Manager

Build a real-time single-elimination tournament manager. Users create tournaments, seed participants, and track match results as the bracket fills out round by round — all state persists and updates live across every connected browser.

## Stack

- **Frontend**: Pure React, port **3000**
- **Backend**: Express, port **3001**
- **Persistence**: PostgreSQL (port **5432**), schema `tournament`
- **Real-time**: WebSockets

## Overview

The app has two views: a tournament list and a bracket view for a single tournament. No authentication is required.

## Tournament List Page (`/`)

The landing page shows all existing tournaments. Each tournament in the list is clickable and navigates to its bracket view.

A **"New Tournament"** form lets the user:
1. Enter a tournament name
2. Enter participant names one at a time (or as a newline-separated list) — the order of entry determines seeding: first entered = seed 1, second = seed 2, etc.
3. Accept 3–16 participants (show a validation error if outside this range)
4. Submit to create the tournament and auto-generate its bracket

A **"Delete All Tournaments"** button permanently removes all tournaments, participants, and match data. It must be clearly visible on this page.

## Bracket Generation Rules

When a tournament is created, the bracket is auto-generated immediately according to these rules:

**Bracket size**: Round up the number of participants to the nearest power of 2 (e.g. 5 participants → 8-slot bracket, 6 → 8, 8 → 8, 9 → 16).

**Byes**: When the participant count is not a power of 2, the top seeds get byes. The number of byes equals `bracketSize − N`. Seed 1 gets the first bye, seed 2 the second, and so on. Bye matches are auto-resolved instantly — the seeded participant advances without any score entry.

**Seeding arrangement**: Participants are placed into the bracket using standard tournament seeding so that the top two seeds are on opposite halves and cannot meet before the final:
- Seed 1 is matched against the lowest remaining seed
- Seed 2 is matched against the second-lowest remaining seed
- This continues until all slots are filled

## Bracket View (`/tournament/:id`)

Displays the full single-elimination bracket as a **left-to-right tree diagram**, with rounds as columns progressing from left (round 1) to right (the final).

Each match is rendered as a box showing:
- Both participant names (or "BYE" for a bye slot)
- Scores, once entered
- Visual indication of the winner

### Match interaction

Clicking a match opens a score entry interface (inline or modal). The user enters a score for each participant and submits.

Rules:
- A match cannot be interacted with until both of its participants are determined (i.e. both prior matches are resolved). Matches with undetermined participants appear **grayed out** and are not clickable.
- Tied scores are rejected — show a visible error message and do not save.
- The participant with the higher score advances to the next round.
- Once a result is saved, the next round's match box updates to show the advancing participant.

### Champion

When all matches are resolved, display the tournament champion's name prominently at the top of the bracket view.

### Live user count

Show a count of currently connected users viewing the page.

## Real-time Sync

All connected clients viewing the same tournament receive match result updates instantly via WebSocket — no page reload required. When a result is entered in one session, all other sessions reflect it automatically.

## Persistence

All tournament data (names, participants, bracket structure, scores, advancement) is stored in PostgreSQL and survives backend restarts. Reloading the page must restore the exact same bracket state.

## `data-testid` Reference

Every interactive and observable element must carry the exact `data-testid` listed below.

### Tournament List

- `tournament-list` — container for all tournament entries
- `tournament-item-{id}` — each tournament row/card, where `{id}` is the tournament's identifier
- `new-tournament-form` — the form for creating a tournament
- `tournament-name-input` — text input for the tournament name
- `participants-input` — input/textarea for entering participant names
- `create-tournament-btn` — the submit button for the new tournament form
- `delete-all-btn` — the "Delete All Tournaments" button
- `form-error` — validation error message shown when input is invalid

### Bracket View

- `bracket-view` — outer container for the entire bracket
- `match-{round}-{position}` — each match box; `round` and `position` are **1-indexed**. Example: first match of round 1 → `match-1-1`, second match of round 2 → `match-2-2`
- `match-participant-top` — the top participant name within a match box (within its match container)
- `match-participant-bottom` — the bottom participant name within a match box
- `match-score-top` — score display for the top participant (within its match container)
- `match-score-bottom` — score display for the bottom participant (within its match container)
- `score-input-top` — score entry field for the top participant (visible when a match is selected)
- `score-input-bottom` — score entry field for the bottom participant
- `submit-score-btn` — confirms and saves the entered scores
- `score-error` — error message shown for tied scores or other invalid input
- `champion` — element displaying the champion's name (only visible once all matches are resolved)
- `connected-users` — live count of connected users

### Navigation

- `back-to-list` — link or button that returns to the tournament list from the bracket view
